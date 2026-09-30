const https = require('https');

const NOTIFICATION_PREFIX = 'notifications.';
const DEFAULT_LEVELS = ['normal', 'warn', 'alert', 'alarm', 'emergency'];
const PRIORITIES = {
  'normal': '-2',
  'warn': '-1',
  'alert': '0',
  'alarm': '1',
  'emergency': '2'
};
const PUSHOVER_TIMEOUT_MS = 10000;
const PUSHOVER_RETRY_SECONDS = 30;
const PUSHOVER_EXPIRE_SECONDS = 3600;
const PUSHOVER_MAX_TITLE = 250;
const PUSHOVER_MAX_MESSAGE = 1024;

module.exports = function (app) {
  var unsubscribes = [];
  var plugin = {};
  var last_states = {};
  var watchList = new Map();
  var vesselName = 'vessels.self';
  var api_user = '';
  var api_key = '';

  plugin.id = 'signalk-pushover-notification-relay';
  plugin.name = 'SignalK Pushover Notification Relay';
  plugin.description = 'SignalK node server notification to Pushover notification relay';

  // The config is whatever the admin UI last saved, so every key is
  // treated as optional: a config written before the notifications list
  // existed, a hand-edited plugin-config-data entry, or a schema field
  // the UI never rendered all arrive with something missing.
  function read_config(options) {

    var notifications = Array.isArray(options.notifications)
      ? options.notifications
      : [];

    return {
      api_user: typeof options.api_user === 'string' ? options.api_user.trim() : '',
      api_key: typeof options.api_key === 'string' ? options.api_key.trim() : '',
      notifications: notifications.filter(function (n) {

        return n && typeof n.path === 'string' && n.path.length > 0;
      })
    };
  }

  // Full notification path -> { levels, sound }. An empty map means
  // "relay every notifications.* path at every level", which is what an
  // empty notifications list asks for.
  function build_watch_list(config) {

    var list = new Map();

    config.notifications.forEach(function (n) {

      list.set(NOTIFICATION_PREFIX + n.path, {
        levels: Array.isArray(n.levels) && n.levels.length > 0
          ? n.levels
          : DEFAULT_LEVELS,
        sound: typeof n.sound === 'string' && n.sound.length > 0
          ? n.sound
          : null
      });
    });

    return list;
  }

  plugin.start = function (options, restartPlugin) {

    // A start() without a preceding stop() leaves the previous
    // subscriptions attached, so every notification gets pushed twice.
    if (unsubscribes.length > 0) {
      unsubscribes.forEach(f => f());
      unsubscribes = [];
    }

    var config = read_config(options || {});

    api_user = config.api_user;
    api_key = config.api_key;
    watchList = build_watch_list(config);

    vesselName = app.getSelfPath('name') || 'vessels.self';

    if (api_user === '' || api_key === '') {

      app.error(`${plugin.id}: a Pushover user key and API key are both required, not subscribing to any notifications.`);
      return;
    }

    var subscribes = [];

    if (config.notifications.length === 0) {

      // signalk-server compiles a subscription path to a regular
      // expression, so this single row already covers nested paths such
      // as notifications.navigation.anchor.
      subscribes.push({
        path: `${NOTIFICATION_PREFIX}*`,
        policy: 'instant'
      });
    } else {
      config.notifications.forEach(function (n) {

        subscribes.push({
          path: NOTIFICATION_PREFIX + n.path,
          policy: 'instant'
        });
      });
    }

    let command = {
      context: 'vessels.self',
      subscribe: subscribes
    };

    app.debug('Subscribe command: ' + JSON.stringify(command, null, 2));
    app.debug('Plugin started with config: ' + JSON.stringify({
      api_user: config.api_user,
      api_key: api_key === '' ? '' : '<set>',
      notifications: config.notifications
    }, null, 2));

    app.subscriptionmanager.subscribe(
      command,
      unsubscribes,
      subscription_error,
      got_delta
    );
  };

  function subscription_error(err) {

    app.error("Subscription error: " + err);
  }

  function got_delta(notification) {

    handle_notification_delta(notification);
  }

  function handle_notification_delta(notification) {

    // This callback runs inside the server's delta dispatch, so a throw
    // here is reported as a plugin error and drops the rest of the batch.
    // Every shape the server can produce is therefore checked before it is
    // indexed. An update carries `meta` instead of `values` whenever
    // metadata is written for a subscribed path (a metadata PUT, or any
    // plugin calling setDefaultMetadata), and signalk-server's toDelta()
    // then builds an update with no `values` key at all.
    if (!notification || !Array.isArray(notification.updates)) {
      return;
    }

    notification.updates.forEach(function (u) {

      if (!u || !Array.isArray(u.values)) {
        return;
      }

      u.values.forEach(handle_notification_value);
    });
  }

  function handle_notification_value(pathValue) {

    var value = pathValue.value;

    if (pathValue.path == null || !value || typeof value !== 'object') {
      return;
    }

    if (typeof value.state !== 'string') {
      return;
    }

    var state = value.state;
    var known = last_states[pathValue.path];

    if (known === state) {
      return;
    }

    // Remember the new state before applying the level filter, so a level
    // that is not relayed still counts as seen and the next relayed level
    // is judged against it.
    last_states[pathValue.path] = state;

    // The first sighting of a path that is already clear is not news.
    if (known === undefined && state === 'normal') {
      return;
    }

    var watched = watchList.get(pathValue.path);
    var levels = watched ? watched.levels : DEFAULT_LEVELS;

    if (levels.indexOf(state) === -1) {
      return;
    }

    send_pushover(pathValue.path,
                  state,
                  typeof value.message === 'string' ? value.message : '',
                  watched ? watched.sound : null);
  }

  function send_pushover(path, state, message, sound) {

    // An unrecognised level is still relayed, at Pushover's normal
    // priority, rather than being sent as priority=undefined.
    var priority = PRIORITIES[state] !== undefined ? PRIORITIES[state] : '0';

    // A state change with no message is still an alert, so the title falls
    // back to the path rather than dropping the notification.
    var subject = message.length > 0 ? message : path;

    var params = {
      token: api_key,
      user: api_user,
      title: truncate(`${vesselName} - ${subject}`, PUSHOVER_MAX_TITLE),
      message: truncate(`State of ${path} toggled to [${state}]`, PUSHOVER_MAX_MESSAGE),
      priority: priority,
      retry: String(PUSHOVER_RETRY_SECONDS),
      expire: String(PUSHOVER_EXPIRE_SECONDS)
    };

    if (sound) {
      params.sound = sound;
    }

    var body = Object.keys(params)
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');

    var options = {
      hostname: 'api.pushover.net',
      port: 443,
      path: '/1/messages.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: PUSHOVER_TIMEOUT_MS
    };

    const req = https.request(options, res => {

      var response = '';

      res.on('data', data => {
        response += data;
      });

      res.on('end', () => {

        if (res.statusCode >= 200 && res.statusCode < 300) {

          app.debug(`Pushover accepted the message for ${path} (HTTP ${res.statusCode}): ${response}`);
          return;
        }

        // Pushover answers a rejected message with a 4xx and a
        // {status:"error",...} body. Reporting only the status code at
        // debug level meant a revoked token or a mistyped user key failed
        // in silence.
        app.error(`Pushover rejected the message for ${path} (HTTP ${res.statusCode}): ${response}`);
      });
    });

    req.on('timeout', () => {

      req.destroy(new Error(`no response within ${PUSHOVER_TIMEOUT_MS}ms`));
    });

    req.on('error', error => {

      app.error(`Error from Pushover request for ${path}: ${error.message}`);
    });

    req.write(body);
    req.end();
  }

  function truncate(text, max) {

    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  plugin.stop = function () {

    unsubscribes.forEach(f => f());
    unsubscribes = [];

    app.debug('Plugin stopped');
  };

  plugin.schema = {
    // The plugin schema
    title: 'Relay Emergency Notifications to Pushover',
    description: 'Pushover Credentials. Go to Pushover dashboard, take note of your user key. Navigate to the bottom of the page, click \'Create an Application/API Token\', fill in the details and note down your API Key.',
    type: 'object',
    required: ['api_user', 'api_key'],
    properties: {
      api_user: {
        type: 'string',
        title: 'Username',
        description: 'The user key from your Pushover account'
      },
      api_key: {
        type: 'string',
        title: 'API Key',
        description: 'The API key from your Pushover dashboard'
      },
      notifications: {
        type: 'array',
        title: 'Notification',
        default: [],
        description: 'Which notifications specifically do you want to be notified for? If none are specified, you will be notified for all state changes of all notification paths.',
        items: {
          type: 'object',
          required: ['path'],
          properties: {
            path: {
              type: 'string',
              title: 'Notification path',
              description: 'The part that comes after \'notification.\' eg: navigation.anchor'
            },
            sound: {
              type: 'string',
              title: 'Notification sound',
              description: 'Override the default notification sound if desired'
            },
            levels: {
              type: 'array',
              title: 'Notification levels',
              default: [],
              description: 'Which notification levels do you want to be notified for? If none are specified, you will be notified for all level changes.',
              items: {
                type: 'string',
                enum: [
                  'normal',
                  'warn',
                  'alert',
                  'alarm',
                  'emergency'
                ]
              }
            }
          }
        }
      }
    }
  };

  return plugin;
};
