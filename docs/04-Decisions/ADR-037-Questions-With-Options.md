# ADR-037 — Questions asked with options, one at a time

**Status:** Accepted · 2026-10-03

## Context
An interview round was a long block of questions and one text box for
all my answers: I had to read everything and write an essay. And when
The Eye needs a choice from me in its conversation (which GitHub
account, which server), it can only ask in prose.

## Decision
- **A question has a shape**: `single` (one option), `multi` (any
  number), `text` (free answer), or `confirm` (yes or no). Options have
  a label and an optional detail; one may be **recommended** (marked,
  and selected first). Every choice question also takes a typed answer
  ("Other").
- **The Eye asks in that shape**: an interview round is a list of such
  questions, and The Eye can put one or more in a reply in its
  conversation. The brain's output schema carries them; a question it
  can't shape stays `text`.
- **Answering** (the interview and The Eye's questions in its
  conversation, the same component): questions in **tabs**, one at a
  time, a summary tab last. Keys: ↑/↓ move between options, Space
  selects (toggles in `multi`), Enter confirms and goes to the next
  question (in a `text` answer, Enter sends and Shift+Enter is a new
  line), ←/→ or Tab move between questions; numbers 1–9 pick an
  option. On a phone, big touch rows. "Submit" sends all answers; a
  question left unanswered takes its recommended option if it has one,
  and is otherwise sent as unanswered.
- **The answers go back structured** (question id → options and text),
  and are shown as a short list in the conversation.

## Consequences
- The interview's single text box goes away; an old round already
  asked shows as before.
- Inbox items for an interview round open the same component.

Related: [[The-Eye]] · [[Web-UI]] · [[Jobs-and-Projects]]
