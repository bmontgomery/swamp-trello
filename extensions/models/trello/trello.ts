/**
 * Trello behavior for swamp. Reads boards, lists (lanes), and cards through the
 * Trello REST API so workflows can watch a lane for work and pull a card's full
 * context: description, members, labels, checklists, custom fields,
 * attachments, and comments.
 *
 * Authenticate with a Trello API key and token, usually supplied from a vault:
 * `apiKey: ${{ vault.get(default, TRELLO_API_KEY) }}`.
 *
 * @module
 */
import { z } from "npm:zod@4";

const TRELLO_API = "https://api.trello.com/1";

/** Trello returns at most this many actions per request (newest first). */
export const MAX_ACTIONS = 1000;

/**
 * Every path segment must be a plain Trello id, short link, or resource name.
 * Ids come from method arguments; rejecting anything else stops `../` from
 * reaching another resource and skipping the board check.
 */
export function apiUrl(path: string): URL {
  if (!/^(\/[A-Za-z0-9]+)+$/.test(path)) {
    throw new Error(`Invalid Trello id in request path: ${path}`);
  }
  return new URL(`${TRELLO_API}${path}`);
}

/** Global arguments shared by every method. */
export const GlobalArgsSchema = z.object({
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Trello API key (https://trello.com/power-ups/admin).",
  ),
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Trello API token authorized for the board.",
  ),
  boardId: z.string().min(1).describe(
    "Board id or short link (the `abc123` in trello.com/b/abc123/name).",
  ),
});

/** Resolved global argument type. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A Trello list (a lane on the board). */
export const ListSchema = z.object({
  id: z.string(),
  name: z.string(),
  closed: z.boolean(),
  pos: z.number(),
});

/** Board lanes, as written by `listLists`. */
export const BoardListsSchema = z.object({
  boardId: z.string(),
  lists: z.array(ListSchema),
  fetchedAt: z.string(),
});

/** Compact card shape returned by `listCards`. */
export const CardSummarySchema = z.object({
  id: z.string(),
  shortLink: z.string(),
  name: z.string(),
  url: z.string(),
  idList: z.string(),
  idMembers: z.array(z.string()),
  memberUsernames: z.array(z.string()),
  labels: z.array(z.string()),
  dateLastActivity: z.string(),
  due: z.string().nullable(),
});

/** Cards in one lane, as written by `listCards`. */
export const CardListSchema = z.object({
  boardId: z.string(),
  listId: z.string(),
  listName: z.string(),
  member: z.string().nullable(),
  cards: z.array(CardSummarySchema),
  fetchedAt: z.string(),
});

/** A comment on a card. `id` is the immutable Trello action id. */
export const CommentSchema = z.object({
  id: z.string(),
  date: z.string(),
  authorId: z.string(),
  authorUsername: z.string().nullable(),
  text: z.string(),
});

/** One checklist item. */
export const CheckItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["complete", "incomplete"]),
  pos: z.number(),
});

/** One checklist with its items. */
export const ChecklistSchema = z.object({
  id: z.string(),
  name: z.string(),
  items: z.array(CheckItemSchema),
});

/** A custom field value on a card, resolved to its field name. */
export const CustomFieldValueSchema = z.object({
  fieldId: z.string(),
  name: z.string(),
  type: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

/** A card attachment. */
export const AttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  mimeType: z.string().nullable(),
  date: z.string(),
  idMember: z.string().nullable(),
  isUpload: z.boolean().describe(
    "True for files uploaded to Trello; false for links to other sites.",
  ),
  bytes: z.number().nullable(),
  dataName: z.string().nullable().describe(
    "Swamp data name holding the file, when it was downloaded.",
  ),
});

/** Full card detail, as written by `getCard`. */
export const CardDetailSchema = z.object({
  id: z.string(),
  shortLink: z.string(),
  name: z.string(),
  desc: z.string(),
  url: z.string(),
  idBoard: z.string(),
  idList: z.string(),
  listName: z.string(),
  closed: z.boolean(),
  idMembers: z.array(z.string()),
  memberUsernames: z.array(z.string()),
  labels: z.array(z.string()),
  due: z.string().nullable(),
  dateLastActivity: z.string(),
  checklists: z.array(ChecklistSchema),
  customFields: z.array(CustomFieldValueSchema),
  attachments: z.array(AttachmentSchema),
  comments: z.array(CommentSchema),
  commentsTruncated: z.boolean().describe(
    "True when the card has more comments than Trello returns (1000); the oldest are missing.",
  ),
  fetchedAt: z.string(),
});

/** Card detail type. */
export type CardDetail = z.infer<typeof CardDetailSchema>;

/** Result of `moveCard`. `changed` is false when the card was already there. */
export const CardMoveSchema = z.object({
  cardId: z.string(),
  fromListId: z.string(),
  fromListName: z.string(),
  toListId: z.string(),
  toListName: z.string(),
  changed: z.boolean(),
  movedAt: z.string(),
});

/** Result of `addComment`. */
export const PostedCommentSchema = CommentSchema.extend({
  cardId: z.string(),
  existing: z.boolean().describe(
    "True when `skipIfContains` matched an earlier comment and nothing was posted.",
  ),
});

/** Result of `attachFile`. */
export const UploadSchema = AttachmentSchema.extend({
  cardId: z.string(),
  replacedAttachmentIds: z.array(z.string()),
});

/** Result of `updateLabels`: the card's labels after the change. */
export const CardLabelsSchema = z.object({
  cardId: z.string(),
  labels: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  updatedAt: z.string(),
});

/** A checklist snapshot after `addChecklistItems` / `setCheckItemState`. */
export const CardChecklistSchema = ChecklistSchema.extend({
  cardId: z.string(),
  updatedAt: z.string(),
});

/** One entry from a card's activity history. */
export const CardActionSchema = z.object({
  id: z.string(),
  type: z.string(),
  date: z.string(),
  memberId: z.string(),
  memberUsername: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});

/** Result of `getCardActions`, oldest first. */
export const CardActionsSchema = z.object({
  cardId: z.string(),
  types: z.array(z.string()),
  since: z.string().nullable(),
  actions: z.array(CardActionSchema),
  truncated: z.boolean().describe(
    "True when Trello's 1000-action limit was reached; the oldest are missing.",
  ),
  fetchedAt: z.string(),
});

/** Minimal fetch signature, so tests can inject a stub. */
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Thin Trello REST client: auth header, JSON parsing, 429 backoff. */
export class TrelloClient {
  /** Create a client for the given credentials. */
  constructor(
    private readonly apiKey: string,
    private readonly apiToken: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly maxRetries = 3,
  ) {}

  /** GET a Trello API path with query params and return parsed JSON. */
  async get<T>(
    path: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const url = apiUrl(path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.request(url, "application/json", path, signal);
    return await res.json() as T;
  }

  /**
   * POST, PUT, or DELETE a Trello API path. Parameters travel in the request
   * body (form-encoded, or multipart for uploads), never in the URL.
   */
  async send<T>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: Record<string, string> | FormData = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.request(
      apiUrl(path),
      "application/json",
      path,
      signal,
      method,
      body instanceof FormData ? body : new URLSearchParams(body),
    );
    return await res.json() as T;
  }

  /**
   * Download an uploaded attachment's bytes. Refuses non-Trello hosts so the
   * credentials are never sent to a third party.
   */
  async download(
    attachmentUrl: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const url = new URL(attachmentUrl);
    if (!isTrelloHost(url)) {
      throw new Error(`Refusing to send Trello credentials to ${url.host}`);
    }
    const res = await this.request(url, "*/*", url.pathname, signal);
    const declared = Number(res.headers.get("Content-Length"));
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new Error(`Attachment is ${declared} bytes; limit is ${maxBytes}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(
        `Attachment is ${bytes.byteLength} bytes; limit is ${maxBytes}`,
      );
    }
    return bytes;
  }

  private async request(
    url: URL,
    accept: string,
    label: string,
    signal?: AbortSignal,
    method = "GET",
    body?: URLSearchParams | FormData,
  ): Promise<Response> {
    for (let attempt = 0;; attempt++) {
      const res = await this.fetchFn(url.toString(), {
        method,
        body,
        headers: {
          Accept: accept,
          // Header auth keeps the token out of URLs and request logs.
          Authorization:
            `OAuth oauth_consumer_key="${this.apiKey}", oauth_token="${this.apiToken}"`,
        },
        signal,
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        await res.body?.cancel();
        const retryAfter = Number(res.headers.get("Retry-After"));
        const delayMs = retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw new Error(
          `Trello ${method} ${label} failed: ${res.status} ${text}`,
        );
      }
      return res;
    }
  }
}

/** True for trello.com and its subdomains over HTTPS. */
export function isTrelloHost(url: URL): boolean {
  return url.protocol === "https:" &&
    (url.hostname === "trello.com" || url.hostname.endsWith(".trello.com"));
}

interface RawMember {
  id: string;
  username: string;
}

interface RawList {
  id: string;
  name: string;
  closed: boolean;
  pos: number;
}

interface RawLabel {
  name: string;
  color: string | null;
}

interface RawCard {
  id: string;
  shortLink: string;
  name: string;
  desc: string;
  url: string;
  idBoard: string;
  idList: string;
  closed: boolean;
  idMembers: string[];
  labels: RawLabel[];
  due: string | null;
  dateLastActivity: string;
  members?: RawMember[];
  checklists?: Array<{
    id: string;
    name: string;
    checkItems: Array<
      { id: string; name: string; state: string; pos: number }
    >;
  }>;
  attachments?: Array<{
    id: string;
    name: string;
    url: string;
    mimeType: string | null;
    date: string;
    idMember: string | null;
    isUpload?: boolean;
    bytes?: number | null;
  }>;
  customFieldItems?: Array<{
    idCustomField: string;
    idValue?: string | null;
    value?: Record<string, string> | null;
  }>;
}

interface RawCustomField {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; value: { text: string } }>;
}

interface RawCommentAction {
  id: string;
  date: string;
  idMemberCreator: string;
  memberCreator?: { username: string };
  data: { text: string };
}

/** Use a label's name, falling back to its color for unnamed labels. */
export function labelText(label: RawLabel): string {
  return label.name || label.color || "";
}

/** Resolve a lane given by id or (case-insensitive) name. */
export function resolveList(lists: RawList[], list: string): RawList {
  const byId = lists.find((l) => l.id === list);
  if (byId) return byId;
  const wanted = list.trim().toLowerCase();
  const byName = lists.filter((l) => l.name.trim().toLowerCase() === wanted);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`List name "${list}" is ambiguous; pass the list id`);
  }
  const names = lists.map((l) => `"${l.name}"`).join(", ");
  throw new Error(`List "${list}" not found on board. Lists: ${names}`);
}

/** Resolve a board member given by id or username (with or without @). */
export function resolveMember(members: RawMember[], member: string): RawMember {
  const wanted = member.replace(/^@/, "").toLowerCase();
  const found = members.find((m) =>
    m.id === member || m.username.toLowerCase() === wanted
  );
  if (!found) throw new Error(`Member "${member}" is not on the board`);
  return found;
}

/** Turn a raw custom-field item into a named, typed value. */
export function customFieldValue(
  item: NonNullable<RawCard["customFieldItems"]>[number],
  defs: RawCustomField[],
): z.infer<typeof CustomFieldValueSchema> {
  const def = defs.find((d) => d.id === item.idCustomField);
  const type = def?.type ?? "unknown";
  let value: string | number | boolean | null = null;
  if (type === "list") {
    value = def?.options?.find((o) => o.id === item.idValue)?.value.text ??
      null;
  } else if (item.value) {
    const raw = item.value[type] ?? Object.values(item.value)[0] ?? null;
    if (type === "number" && raw !== null) value = Number(raw);
    else if (type === "checkbox") value = raw === "true";
    else value = raw;
  }
  return { fieldId: item.idCustomField, name: def?.name ?? "", type, value };
}

/** Map a raw checklist to the stored shape, items in board order. */
export function toChecklist(
  c: NonNullable<RawCard["checklists"]>[number],
): z.infer<typeof ChecklistSchema> {
  return {
    id: c.id,
    name: c.name,
    items: (c.checkItems ?? [])
      .map((i) => ({
        id: i.id,
        name: i.name,
        state: i.state === "complete"
          ? "complete" as const
          : "incomplete" as const,
        pos: i.pos,
      }))
      .sort((a, b) => a.pos - b.pos),
  };
}

/** Map raw API data to the stored card-detail shape. */
export function toCardDetail(
  card: RawCard,
  listName: string,
  customFields: RawCustomField[],
  comments: RawCommentAction[],
  fetchedAt: string,
): CardDetail {
  return {
    id: card.id,
    shortLink: card.shortLink,
    name: card.name,
    desc: card.desc,
    url: card.url,
    idBoard: card.idBoard,
    idList: card.idList,
    listName,
    closed: card.closed,
    idMembers: card.idMembers,
    memberUsernames: (card.members ?? []).map((m) => m.username),
    labels: card.labels.map(labelText),
    due: card.due,
    dateLastActivity: card.dateLastActivity,
    checklists: (card.checklists ?? []).map(toChecklist),
    customFields: (card.customFieldItems ?? []).map((i) =>
      customFieldValue(i, customFields)
    ),
    attachments: (card.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      url: a.url,
      mimeType: a.mimeType || null,
      date: a.date,
      idMember: a.idMember ?? null,
      isUpload: a.isUpload ?? false,
      bytes: a.bytes ?? null,
      dataName: null,
    })),
    // Oldest first, so the last element is the newest comment.
    comments: comments
      .map((c) => ({
        id: c.id,
        date: c.date,
        authorId: c.idMemberCreator,
        authorUsername: c.memberCreator?.username ?? null,
        text: c.data.text,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    commentsTruncated: comments.length >= MAX_ACTIONS,
    fetchedAt,
  };
}

/** Fetch everything about one card and map it to the stored detail shape. */
export async function fetchCardDetail(
  client: TrelloClient,
  cardId: string,
  signal?: AbortSignal,
): Promise<CardDetail> {
  const card = await client.get<RawCard>(`/cards/${cardId}`, {
    fields:
      "shortLink,name,desc,url,idBoard,idList,closed,idMembers,labels,due,dateLastActivity",
    members: "true",
    member_fields: "username",
    checklists: "all",
    attachments: "true",
    customFieldItems: "true",
  }, signal);
  const [list, customFields, comments] = await Promise.all([
    client.get<RawList>(`/lists/${card.idList}`, { fields: "name" }, signal),
    client.get<RawCustomField[]>(
      `/boards/${card.idBoard}/customFields`,
      {},
      signal,
    ),
    client.get<RawCommentAction[]>(`/cards/${card.id}/actions`, {
      filter: "commentCard",
      limit: String(MAX_ACTIONS),
      memberCreator_fields: "username",
    }, signal),
  ]);
  return toCardDetail(
    card,
    list.name,
    customFields,
    comments,
    new Date().toISOString(),
  );
}

/** A downloaded attachment, ready to be written as a swamp file. */
export interface DownloadedAttachment {
  attachmentId: string;
  dataName: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Download every uploaded attachment on a card and set each one's `dataName`.
 * Links to other sites are skipped and keep `dataName: null`.
 */
export async function downloadAttachments(
  client: TrelloClient,
  detail: CardDetail,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<DownloadedAttachment[]> {
  const downloaded: DownloadedAttachment[] = [];
  for (const a of detail.attachments) {
    if (!a.isUpload) continue;
    const dataName = `attachment-${a.id}`;
    downloaded.push({
      attachmentId: a.id,
      dataName,
      contentType: a.mimeType ?? "application/octet-stream",
      bytes: await client.download(a.url, maxBytes, signal),
    });
    a.dataName = dataName;
  }
  return downloaded;
}

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type CreateFileWriter = (
  specName: string,
  name: string,
  overrides?: { contentType?: string },
) => { writeAll: (content: Uint8Array) => Promise<{ name: string }> };

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: WriteResource;
  createFileWriter: CreateFileWriter;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

function clientFor(ctx: MethodContext): TrelloClient {
  return new TrelloClient(ctx.globalArgs.apiKey, ctx.globalArgs.apiToken);
}

/** Card detail plus any attachment bytes, fetched but not yet persisted. */
interface FetchedCard {
  detail: CardDetail;
  files: DownloadedAttachment[];
}

async function fetchCard(
  client: TrelloClient,
  cardId: string,
  opts: { downloadAttachments?: boolean; maxAttachmentBytes: number },
  signal?: AbortSignal,
): Promise<FetchedCard> {
  const detail = await fetchCardDetail(client, cardId, signal);
  const files = opts.downloadAttachments
    ? await downloadAttachments(
      client,
      detail,
      opts.maxAttachmentBytes,
      signal,
    )
    : [];
  return { detail, files };
}

async function persistCard(
  ctx: MethodContext,
  card: FetchedCard,
): Promise<Array<{ name: string }>> {
  const handles = [
    await ctx.writeResource("card", `card-${card.detail.id}`, card.detail),
  ];
  for (const f of card.files) {
    handles.push(
      await ctx.createFileWriter("attachment", f.dataName, {
        contentType: f.contentType,
      }).writeAll(f.bytes),
    );
  }
  return handles;
}

interface RawBoardLabel {
  id: string;
  name: string;
  color: string | null;
}

interface RawAction {
  id: string;
  type: string;
  date: string;
  idMemberCreator: string;
  memberCreator?: { username: string };
  data: Record<string, unknown>;
}

/** The card fields write methods need, with the card's board verified. */
interface CardRef {
  id: string;
  idBoard: string;
  idList: string;
  idLabels: string[];
}

/**
 * Load a card and refuse it unless it is on the configured board, so a wrong
 * card id can never make the behavior change another board.
 */
async function cardOnBoard(
  client: TrelloClient,
  boardId: string,
  card: string,
  signal?: AbortSignal,
): Promise<CardRef> {
  const [board, ref] = await Promise.all([
    client.get<{ id: string }>(`/boards/${boardId}`, { fields: "id" }, signal),
    client.get<CardRef>(`/cards/${card}`, {
      fields: "idBoard,idList,idLabels",
    }, signal),
  ]);
  if (ref.idBoard !== board.id) {
    throw new Error(
      `Card ${card} is not on board ${boardId}; refusing to change it`,
    );
  }
  return ref;
}

/** Resolve a board label given by id or (case-insensitive) name. */
export function resolveLabel(
  labels: RawBoardLabel[],
  label: string,
): RawBoardLabel {
  const byId = labels.find((l) => l.id === label);
  if (byId) return byId;
  const wanted = label.trim().toLowerCase();
  const byName = labels.filter((l) => l.name.trim().toLowerCase() === wanted);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Label name "${label}" is ambiguous; pass the label id`);
  }
  const names = labels.filter((l) => l.name).map((l) => `"${l.name}"`);
  throw new Error(
    `Label "${label}" not found on board. Labels: ${names.join(", ")}`,
  );
}

/** Map a raw activity entry to the stored shape. */
export function toCardAction(a: RawAction): z.infer<typeof CardActionSchema> {
  return {
    id: a.id,
    type: a.type,
    date: a.date,
    memberId: a.idMemberCreator,
    memberUsername: a.memberCreator?.username ?? null,
    data: a.data ?? {},
  };
}

/** Names of `wanted` items not already present (exact, trimmed match). */
export function missingItems(existing: string[], wanted: string[]): string[] {
  const seen = new Set(existing.map((n) => n.trim()));
  const out: string[] = [];
  for (const w of wanted) {
    if (!seen.has(w.trim())) {
      out.push(w);
      seen.add(w.trim());
    }
  }
  return out;
}

async function checklistSnapshot(
  client: TrelloClient,
  cardId: string,
  checklistId: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof CardChecklistSchema>> {
  const raw = await client.get<NonNullable<RawCard["checklists"]>[number]>(
    `/checklists/${checklistId}`,
    { checkItems: "all", checkItem_fields: "name,state,pos" },
    signal,
  );
  return { ...toChecklist(raw), cardId, updatedAt: new Date().toISOString() };
}

const DownloadArgs = {
  downloadAttachments: z.boolean().default(false).describe(
    "Also download uploaded attachments as `attachment-<id>` files.",
  ),
  maxAttachmentBytes: z.number().int().positive().default(10_000_000)
    .describe("Fail if any single attachment is larger than this."),
};

/** Model definition for `@bmonty/trello`. */
export const model = {
  type: "@bmonty/trello",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    boardLists: {
      description: "Open lists (lanes) on the board",
      schema: BoardListsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cardList: {
      description: "Cards in one lane, optionally filtered to one member",
      schema: CardListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    card: {
      description: "Full detail for one card",
      schema: CardDetailSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    move: {
      description: "Result of moving a card (`move-<cardId>`)",
      schema: CardMoveSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    comment: {
      description: "A comment posted to a card (`comment-<actionId>`)",
      schema: PostedCommentSchema,
      lifetime: "infinite",
      garbageCollection: 1,
    },
    upload: {
      description: "A file attached to a card (`upload-<attachmentId>`)",
      schema: UploadSchema,
      lifetime: "infinite",
      garbageCollection: 1,
    },
    labels: {
      description: "A card's labels after `updateLabels` (`labels-<cardId>`)",
      schema: CardLabelsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    checklist: {
      description: "A checklist after a change (`checklist-<checklistId>`)",
      schema: CardChecklistSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    actions: {
      description: "A card's activity history (`actions-<cardId>`)",
      schema: CardActionsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  files: {
    attachment: {
      description: "Downloaded card attachment (`attachment-<attachmentId>`)",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    listLists: {
      description: "List the board's open lanes (useful to find list ids)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { boardId } = ctx.globalArgs;
        const lists = await clientFor(ctx).get<RawList[]>(
          `/boards/${boardId}/lists`,
          { filter: "open", fields: "name,closed,pos" },
          ctx.signal,
        );
        const handle = await ctx.writeResource("boardLists", "board-lists", {
          boardId,
          lists: lists.map(({ id, name, closed, pos }) => ({
            id,
            name,
            closed,
            pos,
          })),
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    listCards: {
      description:
        "List open cards in a lane, optionally only those assigned to a member",
      arguments: z.object({
        list: z.string().min(1).describe("List id or exact list name."),
        member: z.string().optional().describe(
          "Only cards assigned to this member (username or id).",
        ),
        includeDetails: z.boolean().default(false).describe(
          "Also write full detail (`card-<id>`) for every matching card.",
        ),
        ...DownloadArgs,
      }),
      execute: async (
        args: {
          list: string;
          member?: string;
          includeDetails?: boolean;
          downloadAttachments?: boolean;
          maxAttachmentBytes: number;
        },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const client = clientFor(ctx);
        const { boardId } = ctx.globalArgs;
        const [lists, members] = await Promise.all([
          client.get<RawList[]>(`/boards/${boardId}/lists`, {
            filter: "open",
            fields: "name,closed,pos",
          }, ctx.signal),
          client.get<RawMember[]>(`/boards/${boardId}/members`, {
            fields: "username",
          }, ctx.signal),
        ]);
        const list = resolveList(lists, args.list);
        const member = args.member ? resolveMember(members, args.member) : null;
        const usernames = new Map(members.map((m) => [m.id, m.username]));
        const cards = await client.get<RawCard[]>(`/lists/${list.id}/cards`, {
          filter: "open",
          fields:
            "shortLink,name,url,idList,idMembers,labels,dateLastActivity,due",
        }, ctx.signal);
        const matching = cards
          .filter((c) => !member || c.idMembers.includes(member.id))
          .map((c) => ({
            id: c.id,
            shortLink: c.shortLink,
            name: c.name,
            url: c.url,
            idList: c.idList,
            idMembers: c.idMembers,
            memberUsernames: c.idMembers.map((id) => usernames.get(id) ?? id),
            labels: c.labels.map(labelText),
            dateLastActivity: c.dateLastActivity,
            due: c.due,
          }));
        ctx.logger.info("Found {count} card(s) in {list}", {
          count: matching.length,
          list: list.name,
        });
        // Fetch details before writing anything, so a failure persists nothing.
        const fetched: FetchedCard[] = [];
        if (args.includeDetails) {
          for (const c of matching) {
            fetched.push(await fetchCard(client, c.id, args, ctx.signal));
          }
        }
        const handles = [
          await ctx.writeResource("cardList", `list-${list.id}`, {
            boardId,
            listId: list.id,
            listName: list.name,
            member: member?.username ?? null,
            cards: matching,
            fetchedAt: new Date().toISOString(),
          }),
        ];
        for (const card of fetched) {
          handles.push(...await persistCard(ctx, card));
        }
        return { dataHandles: handles };
      },
    },
    getCard: {
      description:
        "Get a card's full detail: description, checklists, custom fields, attachments, comments",
      arguments: z.object({
        card: z.string().min(1).describe("Card id or short link."),
        ...DownloadArgs,
      }),
      execute: async (
        args: {
          card: string;
          downloadAttachments?: boolean;
          maxAttachmentBytes: number;
        },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const card = await fetchCard(
          clientFor(ctx),
          args.card,
          args,
          ctx.signal,
        );
        return { dataHandles: await persistCard(ctx, card) };
      },
    },
    moveCard: {
      description:
        "Move a card to another lane on the board (no-op if already there)",
      arguments: z.object({
        card: z.string().min(1).describe("Card id or short link."),
        list: z.string().min(1).describe("Target list id or exact name."),
        position: z.enum(["top", "bottom"]).default("bottom").describe(
          "Where to place the card in the target lane.",
        ),
      }),
      execute: async (
        args: { card: string; list: string; position: "top" | "bottom" },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const client = clientFor(ctx);
        const { boardId } = ctx.globalArgs;
        const [ref, lists] = await Promise.all([
          cardOnBoard(client, boardId, args.card, ctx.signal),
          client.get<RawList[]>(`/boards/${boardId}/lists`, {
            filter: "open",
            fields: "name,closed,pos",
          }, ctx.signal),
        ]);
        const target = resolveList(lists, args.list);
        const from = lists.find((l) => l.id === ref.idList);
        const changed = ref.idList !== target.id;
        if (changed) {
          await client.send("PUT", `/cards/${ref.id}`, {
            idList: target.id,
            pos: args.position,
          }, ctx.signal);
        }
        ctx.logger.info("Card {card}: {from} -> {to} (changed={changed})", {
          card: ref.id,
          from: from?.name ?? ref.idList,
          to: target.name,
          changed,
        });
        const handle = await ctx.writeResource("move", `move-${ref.id}`, {
          cardId: ref.id,
          fromListId: ref.idList,
          fromListName: from?.name ?? "",
          toListId: target.id,
          toListName: target.name,
          changed,
          movedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    addComment: {
      description: "Post a comment (markdown) to a card",
      arguments: z.object({
        card: z.string().min(1).describe("Card id or short link."),
        text: z.string().min(1).max(16384).describe(
          "Comment text; Trello renders markdown. Max 16384 characters.",
        ),
        skipIfContains: z.string().min(1).optional().describe(
          "Don't post if an existing comment contains this text; makes the call safe to retry.",
        ),
      }),
      execute: async (
        args: { card: string; text: string; skipIfContains?: string },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const client = clientFor(ctx);
        const ref = await cardOnBoard(
          client,
          ctx.globalArgs.boardId,
          args.card,
          ctx.signal,
        );
        let action: RawCommentAction | undefined;
        if (args.skipIfContains) {
          const marker = args.skipIfContains;
          const comments = await client.get<RawCommentAction[]>(
            `/cards/${ref.id}/actions`,
            {
              filter: "commentCard",
              limit: String(MAX_ACTIONS),
              memberCreator_fields: "username",
            },
            ctx.signal,
          );
          action = comments.find((c) => c.data.text.includes(marker));
          if (!action && comments.length >= MAX_ACTIONS) {
            ctx.logger.warning(
              "Card {card} has more than {max} comments; an older comment with the marker would be missed",
              { card: ref.id, max: MAX_ACTIONS },
            );
          }
        }
        const existing = action !== undefined;
        action ??= await client.send<RawCommentAction>(
          "POST",
          `/cards/${ref.id}/actions/comments`,
          { text: args.text },
          ctx.signal,
        );
        const handle = await ctx.writeResource(
          "comment",
          `comment-${action.id}`,
          {
            cardId: ref.id,
            id: action.id,
            date: action.date,
            authorId: action.idMemberCreator,
            authorUsername: action.memberCreator?.username ?? null,
            text: action.data.text,
            existing,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    attachFile: {
      description:
        "Upload a file to a card from text content or a local path, optionally replacing same-named attachments",
      arguments: z.object({
        card: z.string().min(1).describe("Card id or short link."),
        name: z.string().min(1).describe("File name shown on the card."),
        content: z.string().optional().describe(
          "Text content to upload. Give exactly one of content or path.",
        ),
        path: z.string().optional().describe(
          "Local file to upload. Give exactly one of content or path.",
        ),
        mimeType: z.string().default("text/markdown").describe(
          "MIME type of the file.",
        ),
        replaceExisting: z.boolean().default(false).describe(
          "After uploading, delete older attachments with the same name.",
        ),
      }),
      execute: async (
        args: {
          card: string;
          name: string;
          content?: string;
          path?: string;
          mimeType: string;
          replaceExisting: boolean;
        },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        if ((args.content === undefined) === (args.path === undefined)) {
          throw new Error("Give exactly one of `content` or `path`");
        }
        const client = clientFor(ctx);
        const ref = await cardOnBoard(
          client,
          ctx.globalArgs.boardId,
          args.card,
          ctx.signal,
        );
        const bytes = args.path !== undefined
          ? await Deno.readFile(args.path)
          : new TextEncoder().encode(args.content);
        const form = new FormData();
        form.append("name", args.name);
        form.append("mimeType", args.mimeType);
        form.append("setCover", "false");
        form.append(
          "file",
          new Blob([bytes], { type: args.mimeType }),
          args.name,
        );
        // Upload first, then remove older copies: the card is never left
        // without the file if a later step fails.
        const uploaded = await client.send<
          NonNullable<RawCard["attachments"]>[number]
        >("POST", `/cards/${ref.id}/attachments`, form, ctx.signal);
        const replaced: string[] = [];
        if (args.replaceExisting) {
          const existing = await client.get<
            Array<{ id: string; name: string }>
          >(
            `/cards/${ref.id}/attachments`,
            { fields: "name" },
            ctx.signal,
          );
          for (const a of existing) {
            if (a.id !== uploaded.id && a.name === args.name) {
              await client.send(
                "DELETE",
                `/cards/${ref.id}/attachments/${a.id}`,
                {},
                ctx.signal,
              );
              replaced.push(a.id);
            }
          }
        }
        const handle = await ctx.writeResource(
          "upload",
          `upload-${uploaded.id}`,
          {
            cardId: ref.id,
            id: uploaded.id,
            name: uploaded.name,
            url: uploaded.url,
            mimeType: uploaded.mimeType || null,
            date: uploaded.date,
            idMember: uploaded.idMember ?? null,
            isUpload: uploaded.isUpload ?? true,
            bytes: uploaded.bytes ?? bytes.byteLength,
            dataName: null,
            replacedAttachmentIds: replaced,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    updateLabels: {
      description:
        "Add and/or remove board labels on a card (by name or id; idempotent)",
      arguments: z.object({
        card: z.string().min(1).describe("Card id or short link."),
        add: z.array(z.string().min(1)).default([]).describe(
          "Labels to add.",
        ),
        remove: z.array(z.string().min(1)).default([]).describe(
          "Labels to remove.",
        ),
      }),
      execute: async (
        args: { card: string; add: string[]; remove: string[] },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const client = clientFor(ctx);
        const { boardId } = ctx.globalArgs;
        const [ref, boardLabels] = await Promise.all([
          cardOnBoard(client, boardId, args.card, ctx.signal),
          client.get<RawBoardLabel[]>(`/boards/${boardId}/labels`, {
            fields: "name,color",
            limit: "1000",
          }, ctx.signal),
        ]);
        const toAdd = args.add.map((l) => resolveLabel(boardLabels, l));
        const toRemove = args.remove.map((l) => resolveLabel(boardLabels, l));
        const overlap = toAdd.filter((a) =>
          toRemove.some((r) => r.id === a.id)
        );
        if (overlap.length) {
          throw new Error(
            `Labels both added and removed: ${
              overlap.map(labelText).join(", ")
            }`,
          );
        }
        const current = new Set(ref.idLabels);
        const added: string[] = [];
        const removed: string[] = [];
        for (const l of toAdd) {
          if (current.has(l.id)) continue;
          await client.send("POST", `/cards/${ref.id}/idLabels`, {
            value: l.id,
          }, ctx.signal);
          current.add(l.id);
          added.push(labelText(l));
        }
        for (const l of toRemove) {
          if (!current.has(l.id)) continue;
          await client.send(
            "DELETE",
            `/cards/${ref.id}/idLabels/${l.id}`,
            {},
            ctx.signal,
          );
          current.delete(l.id);
          removed.push(labelText(l));
        }
        const byId = new Map(boardLabels.map((l) => [l.id, l]));
        const handle = await ctx.writeResource("labels", `labels-${ref.id}`, {
          cardId: ref.id,
          labels: [...current].map((id) => {
            const l = byId.get(id);
            return l ? labelText(l) : id;
          }),
          added,
          removed,
          updatedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    addChecklistItems: {
      description:
        "Add items to a named checklist on a card, creating the checklist if needed",
      arguments: z.object({
        card: z.string().min(1).describe("Card id or short link."),
        checklist: z.string().min(1).describe(
          "Checklist name (case-insensitive); created if missing.",
        ),
        items: z.array(z.string().min(1)).min(1).describe("Item texts."),
        skipExisting: z.boolean().default(true).describe(
          "Skip items whose text already exists in the checklist.",
        ),
      }),
      execute: async (
        args: {
          card: string;
          checklist: string;
          items: string[];
          skipExisting: boolean;
        },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const client = clientFor(ctx);
        const ref = await cardOnBoard(
          client,
          ctx.globalArgs.boardId,
          args.card,
          ctx.signal,
        );
        const checklists = await client.get<
          NonNullable<RawCard["checklists"]>
        >(`/cards/${ref.id}/checklists`, {
          checkItems: "all",
          checkItem_fields: "name,state,pos",
        }, ctx.signal);
        const wanted = args.checklist.trim().toLowerCase();
        let target = checklists.find((c) =>
          c.name.trim().toLowerCase() === wanted
        );
        if (!target) {
          const created = await client.send<{ id: string; name: string }>(
            "POST",
            `/cards/${ref.id}/checklists`,
            { name: args.checklist },
            ctx.signal,
          );
          target = { ...created, checkItems: [] };
        }
        const items = args.skipExisting
          ? missingItems(target.checkItems.map((i) => i.name), args.items)
          : args.items;
        for (const name of items) {
          await client.send("POST", `/checklists/${target.id}/checkItems`, {
            name,
            pos: "bottom",
          }, ctx.signal);
        }
        const snapshot = await checklistSnapshot(
          client,
          ref.id,
          target.id,
          ctx.signal,
        );
        const handle = await ctx.writeResource(
          "checklist",
          `checklist-${target.id}`,
          snapshot,
        );
        return { dataHandles: [handle] };
      },
    },
    setCheckItemState: {
      description: "Mark a checklist item complete or incomplete",
      arguments: z.object({
        card: z.string().min(1).describe("Card id or short link."),
        item: z.string().min(1).describe("Checklist item id."),
        state: z.enum(["complete", "incomplete"]),
      }),
      execute: async (
        args: { card: string; item: string; state: "complete" | "incomplete" },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const client = clientFor(ctx);
        const ref = await cardOnBoard(
          client,
          ctx.globalArgs.boardId,
          args.card,
          ctx.signal,
        );
        const item = await client.send<{ idChecklist: string }>(
          "PUT",
          `/cards/${ref.id}/checkItem/${args.item}`,
          { state: args.state },
          ctx.signal,
        );
        const snapshot = await checklistSnapshot(
          client,
          ref.id,
          item.idChecklist,
          ctx.signal,
        );
        const handle = await ctx.writeResource(
          "checklist",
          `checklist-${item.idChecklist}`,
          snapshot,
        );
        return { dataHandles: [handle] };
      },
    },
    getCardActions: {
      description:
        "Get a card's activity history (who did what, when), oldest first",
      arguments: z.object({
        card: z.string().min(1).describe("Card id or short link."),
        types: z.array(z.string().min(1)).default(["all"]).describe(
          "Trello action types, e.g. commentCard, updateCard, addAttachmentToCard.",
        ),
        since: z.string().optional().describe(
          "Only actions after this action id or ISO date.",
        ),
      }),
      execute: async (
        args: { card: string; types: string[]; since?: string },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const client = clientFor(ctx);
        const params: Record<string, string> = {
          filter: args.types.join(","),
          limit: String(MAX_ACTIONS),
          memberCreator_fields: "username",
        };
        if (args.since) params.since = args.since;
        const [card, raw] = await Promise.all([
          client.get<{ id: string }>(`/cards/${args.card}`, {
            fields: "id",
          }, ctx.signal),
          client.get<RawAction[]>(
            `/cards/${args.card}/actions`,
            params,
            ctx.signal,
          ),
        ]);
        const cardId = card.id;
        const actions = raw.map(toCardAction)
          .sort((a, b) => a.date.localeCompare(b.date));
        const handle = await ctx.writeResource(
          "actions",
          `actions-${cardId}`,
          {
            cardId,
            types: args.types,
            since: args.since ?? null,
            actions,
            truncated: raw.length >= MAX_ACTIONS,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
