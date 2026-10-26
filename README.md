# @bmonty/trello

A [swamp](https://github.com/swamp-club/swamp) extension for driving work
through Trello boards. Watch a lane for new work, pull everything about a card
into swamp data (description, members, labels, checklists, custom fields,
comments, uploaded attachments, activity history), and act on cards: move
them between lanes, comment, attach files, and manage labels and checklists.
A typical use is a polling workflow that picks up cards assigned to a bot
account, hands them to an automated process, and reports progress back on the
card.

## Installation

```sh
swamp extension pull @bmonty/trello
```

## Setup

Create an API key and token at <https://trello.com/power-ups/admin>, store them
in a vault, and create a behavior pointing at your board. The board id is the
short link in the board URL (`trello.com/b/<boardId>/name`).

```sh
swamp vault put default TRELLO_API_KEY
swamp vault put default TRELLO_API_TOKEN
swamp behavior create @bmonty/trello my-board
```

```yaml
# models/@bmonty/trello/my-board.yaml
globalArguments:
  apiKey: ${{ vault.get(default, TRELLO_API_KEY) }}
  apiToken: ${{ vault.get(default, TRELLO_API_TOKEN) }}
  boardId: AbC123xy
```

Actions taken with the token are attributed to the Trello account that created
it, so use a dedicated account for automation.

## Methods

Read:

| Method           | Arguments                                                                                        | Writes                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `listLists`      | none                                                                                             | `board-lists`                                                                 |
| `listCards`      | `list` (id or name), `member?`, `includeDetails?`, `downloadAttachments?`, `maxAttachmentBytes?` | `list-<listId>`, plus `card-<id>` / `attachment-<id>` per card when requested |
| `getCard`        | `card` (id or short link), `downloadAttachments?`, `maxAttachmentBytes?`                         | `card-<id>`, `attachment-<id>`                                                |
| `getCardActions` | `card`, `types?` (Trello action types, default `all`), `since?` (action id or date)              | `actions-<cardId>`                                                            |

Write (each refuses cards that are not on the configured board):

| Method              | Arguments                                                                               | Writes                    |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------- |
| `moveCard`          | `card`, `list` (id or name), `position?` (`top`/`bottom`)                               | `move-<cardId>`           |
| `addComment`        | `card`, `text` (markdown, max 16384 chars), `skipIfContains?`                         | `comment-<actionId>`      |
| `attachFile`        | `card`, `name`, `content` or `path`, `mimeType?` (default `text/markdown`), `replaceExisting?` | `upload-<attachmentId>`   |
| `updateLabels`      | `card`, `add?`, `remove?` (label names or ids)                                          | `labels-<cardId>`         |
| `addChecklistItems` | `card`, `checklist` (name; created if missing), `items`, `skipExisting?` (default true) | `checklist-<checklistId>` |
| `setCheckItemState` | `card`, `item` (id), `state` (`complete`/`incomplete`)                                  | `checklist-<checklistId>` |

Writes are safe to retry where Trello allows it: moving a card to the lane it
is already in, adding a label it already has, or adding checklist items that
already exist changes nothing. `addComment` is retry-safe when you pass
`skipIfContains`: put a unique marker in the text, and if any comment on the
card already contains it, that comment is recorded (`existing: true`) instead
of posting again. Trello returns at most the newest 1000 comments, so a marker
older than that is missed; `getCard` sets `commentsTruncated` and
`getCardActions` sets `truncated` when that limit was reached.
`attachFile` with `replaceExisting` uploads first and only then deletes older
same-named attachments, so the card never loses the file mid-update.

Watch a lane for cards assigned to a bot, with full detail in one call:

```sh
swamp behavior run my-board listCards \
  --input list="Ready for Development" \
  --input member=my-bot-username \
  --input includeDetails=true \
  --input downloadAttachments=true
```

Reference the results from other behaviors or workflows with CEL:

```
data.latest("my-board", "list-<listId>").attributes.cards
data.latest("my-board", "card-<cardId>").attributes.comments
```

## Behavior notes

- Credentials are sent in the `Authorization` header, never in URLs. Attachment
  downloads only go to `https://*.trello.com`; links to other sites are listed
  but not fetched.
- Comments are returned oldest first. Each has the immutable Trello action
  `id`, which works as a watermark for detecting new comments.
- Custom field values are resolved to their field names (dropdowns to option
  text). Some Trello plans don't offer custom fields; the list is empty then.
- Trello's activity history (`getCardActions`) records who moved a card,
  commented, attached a file, or ticked a checklist item, but **not** label
  changes. If you need to know who approved something, use a checklist item
  or a comment as the signal rather than a label.
- HTTP 429 responses are retried with `Retry-After` / exponential backoff.
- A lane name that matches no list fails with the board's list names, so a
  typo can't silently return zero cards.

## Development

```sh
deno test extensions/models/trello/
swamp extension source add /path/to/swamp-trello   # load from a local clone
```

## License

MIT. See [LICENSE](LICENSE).
