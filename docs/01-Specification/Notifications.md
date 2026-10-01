# Notifications

**Is:** how Oraknid tells me it needs me, or that something happened.
**Is not:** the activity stream. Notifications are few, and every one
of them is worth interrupting me for.

## Channels

All three are built in the MVP. Each can be switched on or off in
Settings → Notifications.

| Channel | How | Default |
| :-- | :-- | :-- |
| **Desktop** | Native Linux notification via the freedesktop notification service. Clicking it opens the item in the UI. | On |
| **Web push** | The UI is a PWA. Each paired device can subscribe. Works on my phone once it can reach the daemon (local network now, The Nest later). | On for devices that subscribed |
| **Email** | SMTP. I enter the server and the address. The password goes to the keychain. | Off until configured |

## Events and default routing

| Event | Desktop | Push | Email |
| :-- | :-- | :-- | :-- |
| Approval needed | ✓ | ✓ | ✓ after 15 min unanswered |
| Question / interview round waiting | ✓ | ✓ | ✓ after 15 min |
| Job completed | ✓ | ✓ | ✓ |
| Job blocked | ✓ | ✓ | ✓ |
| Escalation reached step 5 (ask me) | ✓ | ✓ | ✓ |
| Budget at 80% / reached | ✓ | ✓ | — |
| Time alarm | ✓ | ✓ | ✓ |
| Recovered after crash or reboot | ✓ | ✓ | — |
| Leg unavailable / rate-limited | — | — | — |

I can change every cell. **Quiet hours** hold everything except
approvals for running jobs. Repeated events are grouped
("3 approvals waiting").

## Content

Notifications say what happened and what I need to do, in one line. No
secrets and no untrusted content beyond a short, escaped excerpt
(BR-13, BR-15). Email notifications link to the UI. They never contain
approve buttons that work without signing in.

Related: [[Approvals-and-Autonomy]] · [[Web-UI]] · [[Security]] · [[The-Nest]]
