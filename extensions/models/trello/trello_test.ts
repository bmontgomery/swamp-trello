import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  apiUrl,
  type CardDetail,
  customFieldValue,
  downloadAttachments,
  fetchCardDetail,
  type FetchFn,
  isTrelloHost,
  missingItems,
  model,
  resolveLabel,
  resolveList,
  resolveMember,
  toCardAction,
  toCardDetail,
  TrelloClient,
} from "./trello.ts";

const lists = [
  { id: "l1", name: "Ready for Development", closed: false, pos: 1 },
  { id: "l2", name: "In Progress", closed: false, pos: 2 },
  { id: "l3", name: "Dup", closed: false, pos: 3 },
  { id: "l4", name: "dup ", closed: false, pos: 4 },
];

Deno.test("resolveList matches id, then case-insensitive name", () => {
  assertEquals(resolveList(lists, "l2").name, "In Progress");
  assertEquals(resolveList(lists, " ready for development ").id, "l1");
});

Deno.test("resolveList rejects ambiguous and unknown names", () => {
  assertThrows(() => resolveList(lists, "dup"), Error, "ambiguous");
  assertThrows(() => resolveList(lists, "Nope"), Error, "not found");
});

Deno.test("resolveMember matches id or username with optional @", () => {
  const members = [{ id: "m1", username: "example-bot" }];
  assertEquals(resolveMember(members, "m1").username, "example-bot");
  assertEquals(resolveMember(members, "@Example-Bot").id, "m1");
  assertThrows(
    () => resolveMember(members, "someone"),
    Error,
    "not on the board",
  );
});

const fieldDefs = [
  {
    id: "f-list",
    name: "Design Decision",
    type: "list",
    options: [
      { id: "o1", value: { text: "Pending" } },
      { id: "o2", value: { text: "Approved" } },
    ],
  },
  { id: "f-num", name: "Points", type: "number" },
  { id: "f-chk", name: "Urgent", type: "checkbox" },
  { id: "f-txt", name: "PR URL", type: "text" },
];

Deno.test("customFieldValue resolves each field type", () => {
  assertEquals(
    customFieldValue({ idCustomField: "f-list", idValue: "o2" }, fieldDefs)
      .value,
    "Approved",
  );
  assertEquals(
    customFieldValue(
      { idCustomField: "f-num", value: { number: "3.5" } },
      fieldDefs,
    ).value,
    3.5,
  );
  assertEquals(
    customFieldValue(
      { idCustomField: "f-chk", value: { checked: "true" } },
      fieldDefs,
    ).value,
    true,
  );
  assertEquals(
    customFieldValue(
      { idCustomField: "f-txt", value: { text: "https://x/pr/1" } },
      fieldDefs,
    ),
    {
      fieldId: "f-txt",
      name: "PR URL",
      type: "text",
      value: "https://x/pr/1",
    },
  );
  assertEquals(
    customFieldValue({ idCustomField: "gone", value: null }, fieldDefs),
    { fieldId: "gone", name: "", type: "unknown", value: null },
  );
});

Deno.test("toCardDetail sorts comments oldest-first and checklist items by pos", () => {
  const detail = toCardDetail(
    {
      id: "c1",
      shortLink: "abc",
      name: "Card",
      desc: "",
      url: "u",
      idBoard: "b",
      idList: "l1",
      closed: false,
      idMembers: ["m1"],
      labels: [{ name: "", color: "red" }, { name: "Bug", color: "blue" }],
      due: null,
      dateLastActivity: "2026-10-24T00:00:00Z",
      members: [{ id: "m1", username: "bot" }],
      checklists: [{
        id: "cl",
        name: "Open Questions",
        checkItems: [
          { id: "i2", name: "second", state: "complete", pos: 2 },
          { id: "i1", name: "first", state: "incomplete", pos: 1 },
        ],
      }],
    },
    "Ready for Development",
    [],
    [
      {
        id: "a2",
        date: "2026-10-24T02:00:00Z",
        idMemberCreator: "m2",
        memberCreator: { username: "pat" },
        data: { text: "later" },
      },
      {
        id: "a1",
        date: "2026-10-24T01:00:00Z",
        idMemberCreator: "m2",
        data: { text: "earlier" },
      },
    ],
    "now",
  );
  assertEquals(detail.comments.map((c) => c.id), ["a1", "a2"]);
  assertEquals(detail.comments[0].authorUsername, null);
  assertEquals(detail.checklists[0].items.map((i) => i.id), ["i1", "i2"]);
  assertEquals(detail.labels, ["red", "Bug"]);
  assertEquals(detail.memberUsernames, ["bot"]);
  assertEquals(detail.attachments, []);
  assertEquals(detail.commentsTruncated, false);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("TrelloClient sends header auth, never puts the token in the URL", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const stub: FetchFn = (url, init) => {
    seenUrl = url;
    seenAuth = new Headers(init?.headers).get("Authorization") ?? "";
    return Promise.resolve(jsonResponse([]));
  };
  await new TrelloClient("KEY", "TOKEN", stub).get("/boards/b/lists", {
    filter: "open",
  });
  assertEquals(seenUrl, "https://api.trello.com/1/boards/b/lists?filter=open");
  assertEquals(
    seenAuth,
    'OAuth oauth_consumer_key="KEY", oauth_token="TOKEN"',
  );
});

Deno.test("TrelloClient retries on 429 then succeeds", async () => {
  let calls = 0;
  const stub: FetchFn = () => {
    calls++;
    return Promise.resolve(
      calls === 1
        ? new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "1" },
        })
        : jsonResponse({ ok: true }),
    );
  };
  const result = await new TrelloClient("k", "t", stub).get<{ ok: boolean }>(
    "/x",
  );
  assertEquals(result.ok, true);
  assertEquals(calls, 2);
});

Deno.test("TrelloClient throws with status on errors and gives up after retries", async () => {
  const notFound: FetchFn = () =>
    Promise.resolve(new Response("invalid id", { status: 404 }));
  await assertRejects(
    () => new TrelloClient("k", "t", notFound).get("/cards/x"),
    Error,
    "404 invalid id",
  );
  const always429: FetchFn = () =>
    Promise.resolve(
      new Response("", { status: 429, headers: { "Retry-After": "1" } }),
    );
  await assertRejects(
    () => new TrelloClient("k", "t", always429, 0).get("/x"),
    Error,
    "429",
  );
});

Deno.test("fetchCardDetail combines card, list, custom fields, and comments", async () => {
  const routes: Record<string, unknown> = {
    "/1/cards/abc": {
      id: "c1",
      shortLink: "abc",
      name: "Card",
      desc: "d",
      url: "u",
      idBoard: "b1",
      idList: "l1",
      closed: false,
      idMembers: [],
      labels: [],
      due: null,
      dateLastActivity: "t",
      customFieldItems: [{ idCustomField: "f-list", idValue: "o1" }],
    },
    "/1/lists/l1": { id: "l1", name: "Design Review" },
    "/1/boards/b1/customFields": fieldDefs,
    "/1/cards/c1/actions": [{
      id: "a1",
      date: "t",
      idMemberCreator: "m",
      data: { text: "hi" },
    }],
  };
  const stub: FetchFn = (url) => {
    const path = new URL(url).pathname;
    return Promise.resolve(
      path in routes ? jsonResponse(routes[path]) : jsonResponse({}, 404),
    );
  };
  const detail = await fetchCardDetail(new TrelloClient("k", "t", stub), "abc");
  assertEquals(detail.listName, "Design Review");
  assertEquals(detail.customFields[0].name, "Design Decision");
  assertEquals(detail.customFields[0].value, "Pending");
  assertEquals(detail.comments[0].text, "hi");
});

Deno.test("isTrelloHost accepts only https trello.com and subdomains", () => {
  assertEquals(isTrelloHost(new URL("https://trello.com/1/cards/x")), true);
  assertEquals(isTrelloHost(new URL("https://api.trello.com/1/x")), true);
  assertEquals(isTrelloHost(new URL("http://trello.com/x")), false);
  assertEquals(isTrelloHost(new URL("https://eviltrello.com/x")), false);
  assertEquals(isTrelloHost(new URL("https://trello.com.evil.io/x")), false);
});

Deno.test("download never sends credentials to non-Trello hosts", async () => {
  let called = false;
  const stub: FetchFn = () => {
    called = true;
    return Promise.resolve(new Response("x"));
  };
  await assertRejects(
    () =>
      new TrelloClient("k", "t", stub).download(
        "https://example.com/file.txt",
        100,
      ),
    Error,
    "Refusing",
  );
  assertEquals(called, false);
});

Deno.test("download enforces the size limit", async () => {
  const stub: FetchFn = () => Promise.resolve(new Response("0123456789"));
  const client = new TrelloClient("k", "t", stub);
  const url = "https://trello.com/1/cards/c/attachments/a/download/f.txt";
  assertEquals((await client.download(url, 10)).byteLength, 10);
  await assertRejects(() => client.download(url, 9), Error, "limit is 9");
});

Deno.test("downloadAttachments fetches uploads, skips links, sets dataName", async () => {
  const urls: string[] = [];
  const stub: FetchFn = (url) => {
    urls.push(url);
    return Promise.resolve(new Response("hello"));
  };
  const attachment = (id: string, url: string, isUpload: boolean) => ({
    id,
    name: id,
    url,
    mimeType: null,
    date: "t",
    idMember: null,
    isUpload,
    bytes: null,
    dataName: null,
  });
  const detail = {
    attachments: [
      attachment(
        "up",
        "https://trello.com/1/cards/c/attachments/up/download/a.md",
        true,
      ),
      attachment("link", "https://example.com/spec", false),
    ],
  } as unknown as CardDetail;
  const files = await downloadAttachments(
    new TrelloClient("k", "t", stub),
    detail,
    1000,
  );
  assertEquals(files.map((f) => f.dataName), ["attachment-up"]);
  assertEquals(files[0].contentType, "application/octet-stream");
  assertEquals(new TextDecoder().decode(files[0].bytes), "hello");
  assertEquals(detail.attachments.map((a) => a.dataName), [
    "attachment-up",
    null,
  ]);
  assertEquals(urls.length, 1);
});

// ---- write methods, run against a fake Trello via a stubbed global fetch ----

interface Call {
  method: string;
  path: string;
  body: URLSearchParams | FormData | null;
}

type Route = (call: Call) => unknown;

async function withFakeTrello(
  routes: Record<string, Route>,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const url = new URL(input);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/1/, ""),
      body: (init?.body as URLSearchParams | FormData) ?? null,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    return Promise.resolve(
      route
        ? jsonResponse(route(call))
        : new Response(`no route ${call.method} ${call.path}`, { status: 404 }),
    );
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function fakeCtx() {
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    written,
    ctx: {
      globalArgs: { apiKey: "k", apiToken: "t", boardId: "B" },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      createFileWriter: () => ({
        writeAll: () => Promise.resolve({ name: "f" }),
      }),
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

const board = { "GET /boards/B": () => ({ id: "board1" }) };
const boardLists = {
  "GET /boards/B/lists": () => [
    { id: "ready", name: "Ready for Development", closed: false, pos: 1 },
    { id: "wip", name: "In Progress", closed: false, pos: 2 },
  ],
};
const cardIn = (
  idList: string,
  idLabels: string[] = [],
  idBoard = "board1",
) => ({
  "GET /cards/c1": () => ({ id: "c1", idBoard, idList, idLabels }),
});
const { methods } = model;

Deno.test("moveCard moves the card and records from/to", async () => {
  await withFakeTrello({
    ...board,
    ...boardLists,
    ...cardIn("ready"),
    "PUT /cards/c1": () => ({}),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await methods.moveCard.execute({
      card: "c1",
      list: "in progress",
      position: "top",
    }, ctx);
    const put = calls.find((c) => c.method === "PUT")!;
    assertEquals((put.body as URLSearchParams).get("idList"), "wip");
    assertEquals((put.body as URLSearchParams).get("pos"), "top");
    assertEquals(written[0].name, "move-c1");
    assertEquals(written[0].data.fromListName, "Ready for Development");
    assertEquals(written[0].data.changed, true);
  });
});

Deno.test("moveCard is a no-op when the card is already in the lane", async () => {
  await withFakeTrello(
    { ...board, ...boardLists, ...cardIn("wip") },
    async (calls) => {
      const { ctx, written } = fakeCtx();
      await methods.moveCard.execute({
        card: "c1",
        list: "wip",
        position: "bottom",
      }, ctx);
      assertEquals(calls.some((c) => c.method === "PUT"), false);
      assertEquals(written[0].data.changed, false);
    },
  );
});

Deno.test("write methods refuse cards on another board", async () => {
  await withFakeTrello(
    { ...board, ...boardLists, ...cardIn("ready", [], "otherBoard") },
    async (calls) => {
      const { ctx, written } = fakeCtx();
      await assertRejects(
        () => methods.addComment.execute({ card: "c1", text: "hi" }, ctx),
        Error,
        "not on board",
      );
      await assertRejects(
        () =>
          methods.moveCard.execute({
            card: "c1",
            list: "wip",
            position: "bottom",
          }, ctx),
        Error,
        "not on board",
      );
      assertEquals(calls.filter((c) => c.method !== "GET").length, 0);
      assertEquals(written.length, 0);
    },
  );
});

Deno.test("addComment sends text in the body and records the action id", async () => {
  await withFakeTrello({
    ...board,
    ...cardIn("ready"),
    "POST /cards/c1/actions/comments": (call) => ({
      id: "a9",
      date: "2026-10-24T00:00:00Z",
      idMemberCreator: "bot",
      memberCreator: { username: "example-bot" },
      data: { text: (call.body as URLSearchParams).get("text") },
    }),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await methods.addComment.execute({
      card: "c1",
      text: "**Design v1** ready",
    }, ctx);
    const post = calls.find((c) => c.method === "POST")!;
    assertEquals(post.path, "/cards/c1/actions/comments");
    assertEquals(written[0].name, "comment-a9");
    assertEquals(written[0].data.text, "**Design v1** ready");
    assertEquals(written[0].data.authorUsername, "example-bot");
  });
});

Deno.test("attachFile uploads first, then deletes only older same-named files", async () => {
  await withFakeTrello({
    ...board,
    ...cardIn("ready"),
    "POST /cards/c1/attachments": () => ({
      id: "new",
      name: "design.md",
      url: "https://trello.com/x",
      mimeType: "text/markdown",
      date: "t",
      idMember: "bot",
      isUpload: true,
      bytes: 5,
    }),
    "GET /cards/c1/attachments": () => [
      { id: "old", name: "design.md" },
      { id: "new", name: "design.md" },
      { id: "other", name: "notes.md" },
    ],
    "DELETE /cards/c1/attachments/old": () => ({}),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await methods.attachFile.execute({
      card: "c1",
      name: "design.md",
      content: "# Hi",
      mimeType: "text/markdown",
      replaceExisting: true,
    }, ctx);
    const writes = calls.filter((c) => c.method !== "GET").map((c) =>
      `${c.method} ${c.path}`
    );
    assertEquals(writes, [
      "POST /cards/c1/attachments",
      "DELETE /cards/c1/attachments/old",
    ]);
    const file = (calls[2].body as FormData).get("file") as File;
    assertEquals(await file.text(), "# Hi");
    assertEquals(written[0].data.replacedAttachmentIds, ["old"]);
  });
});

Deno.test("attachFile requires exactly one of content or path", async () => {
  const { ctx } = fakeCtx();
  await assertRejects(
    () =>
      methods.attachFile.execute({
        card: "c1",
        name: "x.md",
        mimeType: "text/markdown",
        replaceExisting: false,
      }, ctx),
    Error,
    "exactly one",
  );
});

Deno.test("updateLabels only adds missing and removes present labels", async () => {
  await withFakeTrello({
    ...board,
    ...cardIn("ready", ["lApproved", "lBug"]),
    "GET /boards/B/labels": () => [
      { id: "lApproved", name: "Design: Approved", color: "green" },
      { id: "lChanges", name: "Design: Changes Requested", color: "orange" },
      { id: "lBug", name: "Bug", color: "red" },
    ],
    "POST /cards/c1/idLabels": () => [],
    "DELETE /cards/c1/idLabels/lApproved": () => [],
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await methods.updateLabels.execute({
      card: "c1",
      add: ["Bug", "design: changes requested"],
      remove: ["Design: Approved"],
    }, ctx);
    const writes = calls.filter((c) => c.method !== "GET").map((c) =>
      `${c.method} ${c.path}`
    );
    assertEquals(writes, [
      "POST /cards/c1/idLabels",
      "DELETE /cards/c1/idLabels/lApproved",
    ]);
    assertEquals(written[0].data.added, ["Design: Changes Requested"]);
    assertEquals(written[0].data.removed, ["Design: Approved"]);
    assertEquals(written[0].data.labels, ["Bug", "Design: Changes Requested"]);
  });
});

Deno.test("resolveLabel matches id or name and lists labels when missing", () => {
  const labels = [{ id: "l1", name: "Design: Approved", color: "green" }];
  assertEquals(resolveLabel(labels, "l1").name, "Design: Approved");
  assertEquals(resolveLabel(labels, " design: approved ").id, "l1");
  assertThrows(() => resolveLabel(labels, "Nope"), Error, '"Design: Approved"');
});

Deno.test("addChecklistItems creates the checklist and skips existing items", async () => {
  await withFakeTrello({
    ...board,
    ...cardIn("ready"),
    "GET /cards/c1/checklists": () => [{
      id: "cl1",
      name: "Open Questions",
      checkItems: [{ id: "i1", name: "Q1?", state: "incomplete", pos: 1 }],
    }],
    "POST /checklists/cl1/checkItems": () => ({}),
    "GET /checklists/cl1": () => ({
      id: "cl1",
      name: "Open Questions",
      checkItems: [
        { id: "i1", name: "Q1?", state: "incomplete", pos: 1 },
        { id: "i2", name: "Q2?", state: "incomplete", pos: 2 },
      ],
    }),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await methods.addChecklistItems.execute({
      card: "c1",
      checklist: "open questions",
      items: ["Q1?", "Q2?", "Q2?"],
      skipExisting: true,
    }, ctx);
    const posts = calls.filter((c) => c.method === "POST");
    assertEquals(posts.length, 1);
    assertEquals((posts[0].body as URLSearchParams).get("name"), "Q2?");
    assertEquals(written[0].name, "checklist-cl1");
    assertEquals((written[0].data.items as unknown[]).length, 2);
  });
});

Deno.test("missingItems dedupes against existing and within the request", () => {
  assertEquals(missingItems(["a", " b "], ["a", "b", "c", "c "]), ["c"]);
});

Deno.test("toCardAction keeps type, author, and raw data", () => {
  assertEquals(
    toCardAction({
      id: "x",
      type: "updateCard",
      date: "t",
      idMemberCreator: "m",
      data: { listAfter: { name: "In Progress" } },
    }),
    {
      id: "x",
      type: "updateCard",
      date: "t",
      memberId: "m",
      memberUsername: null,
      data: { listAfter: { name: "In Progress" } },
    },
  );
});

Deno.test("addComment with skipIfContains reuses a matching comment instead of posting", async () => {
  await withFakeTrello({
    ...board,
    ...cardIn("ready"),
    "GET /cards/c1/actions": () => [
      {
        id: "a1",
        date: "t",
        idMemberCreator: "bot",
        data: { text: "Picked up `ai-pipeline:claimed`" },
      },
    ],
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await methods.addComment.execute({
      card: "c1",
      text: "Picked up again `ai-pipeline:claimed`",
      skipIfContains: "ai-pipeline:claimed",
    }, ctx);
    assertEquals(calls.some((c) => c.method === "POST"), false);
    assertEquals(written[0].name, "comment-a1");
    assertEquals(written[0].data.existing, true);
  });
});

Deno.test("apiUrl accepts plain ids and rejects path tricks", () => {
  assertEquals(
    apiUrl("/cards/abc123/actions").toString(),
    "https://api.trello.com/1/cards/abc123/actions",
  );
  for (
    const bad of [
      "/cards/../boards/x",
      "/cards/a%2F..",
      "/cards/a b",
      "/cards/",
    ]
  ) {
    assertThrows(() => apiUrl(bad), Error, "Invalid Trello id");
  }
});
