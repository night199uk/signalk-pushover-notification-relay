# signalk-pushover-notification-relay

Signalk-node-server plugin that pushes listens for change of state in SignalK notifications and sends the updates via push message gateway Pushover (https://pushover.net/). Particularly useful to keep an eye on your boat when you are not aboard. The author created this plugin to enable remote notification of anchor dragging emergencies.

# About Pushover

<img src="pushover-wordmark.png" height="26" alt="Pushover">

Pushover (no affiliation with the author or this software) makes it easy to get real-time notifications on your Android, iPhone, iPad, and Desktop (Android Wear and Apple Watch, too!).
This plugin uses it to forward your notifications to your mobile phone via push message.
This plugin is not written or supported by Pushover. It is an independent integration that uses their public API.
Pushover is a commercial service and you will need to pay a fee. You can get started for free however, you will be given a trial period for testing when you sign up.

# Installation

First you'll  want to make sure you have the latest and greatest [signalk-server-node](https://github.com/SignalK/signalk-server-node) installed. Please see instructions there for initial install.
Next install the node server plugins that you want. Go to <http://localhost:3000/appstore> and install:

signalk-pushover-notification-relay

# Configuration

<img align="right" src="config.png">

Go to your Pushover dashboard and note down your User Key. Navigate to the bottom of the page and create and API Key, note it down.

Navigate to http://localhost:3000/admin/#/serverConfiguration/plugins/signalk-pushover-notification-relay, and enter your Pushover user key and API key.

You can leave the Notifications section empty if you want a notification for all notification.* paths and all states. Otherwise, add one entry per thing you care about and restrict it with levels, for example `navigation.anchor` at `normal` and `emergency`.

You can also override the default sound if you wish.

# Matching notification paths

The Notification path field takes the part of the path after `notifications.`, and `*` is the only wildcard. It stands for any run of characters, dots included.

| Path | Matches |
| --- | --- |
| `navigation` | `notifications.navigation` and nothing below it |
| `navigation.*` | everything under `notifications.navigation`, at any depth |
| `*` | every notification |

So a single `environment.*` entry covers `environment.hull.waterLevel`, `environment.hull.seacocks`, `environment.engine.waterTemperature` and so on, rather than needing an entry for each one.

Note that `navigation.*` does not match `navigation` itself, because a `.` has to precede the `*`. Add a second entry for it if you want both.

Every other character is literal, so a path is always matched whole: `?` is a question mark rather than a single-character wildcard, and `[ae]` is four literal characters rather than a character class.

This is the same matching Signal K itself uses for a subscription path, so a path that works here works there.

When more than one entry matches a notification, the **first** one wins, and supplies its levels and sound. List the specific entries above the general ones:

- `navigation.anchor` — emergency only, siren
- `navigation.*` — warn and emergency, default sound

Favouring globs over long lists of individual paths is also a little faster: every configured path becomes its own subscription, and a vessel with a few hundred notifications is better served by ten globs than by two hundred rows.

That's it.

# Trademarks

Pushover is a trademark of Pushover, LLC. The Pushover wordmark above is used to indicate that this plugin integrates with that service, and is neither modified nor used as this plugin's own icon, in line with their [logo usage terms](https://support.pushover.net/i63-pushover-logos-and-usage). The plugin icon in `icon.png` is original artwork.
