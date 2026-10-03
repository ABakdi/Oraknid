# Mail

Oraknid can hold your mail accounts, so your agents can read, sort and draft, and so you can do it all in one place.

## Adding an account

On the **Mail** page, **Add an account**. Pick Gmail, Outlook or another provider, and IMAP or POP3:

- **Gmail and Outlook**: use an **app password**, made in your account's security settings. Oraknid shows the link.
- **Any other provider**: its IMAP or POP3 server and its SMTP server.

The password goes to your keychain, never to Oraknid's database. If it stops working, the account shows **Reconnect**.

With IMAP, what you do (read, star, move, delete) happens on the server, so your other mail apps see it. With POP3, mail is downloaded and kept here; it stays on the server unless you turn on **delete from server**.

## Reading safely

Mail is shown in a frame where nothing can run. Remote images, which tell a sender you opened their mail, stay hidden until you allow them for a message or a sender.

## Agents and mail

A job whose skill uses the **email** tool can search, read, label, move, and write drafts. An agent's draft is marked as such and waits in **Waiting for you** until you approve it. Nothing is sent without you, unless you turn on auto-send for an account. Every agent action on your mail is in the log.
