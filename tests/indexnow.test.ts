import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// config reads the environment at module load — set overrides before any
// project module (helpers → migrate → config) is imported.
process.env.INDEXNOW_ENABLED = "true";
process.env.INDEXNOW_KEY = "";

const { testDb } = await import("./helpers.js");
const { IndexNowService } = await import("../src/modules/seo/indexnow.js");
const { SettingsService } = await import("../src/modules/settings/service.js");
const { config } = await import("../src/config/index.js");

describe("IndexNowService", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("generates a key once and persists it in settings", () => {
    const db = testDb();
    const a = new IndexNowService(db);
    expect(a.key).toMatch(/^[0-9a-f]{32}$/);
    expect(a.keyFileName).toBe(`${a.key}.txt`);
    // a second service on the same DB reuses the persisted key
    const b = new IndexNowService(db);
    expect(b.key).toBe(a.key);
    expect(new SettingsService(db).get("indexnow_key", "")).toBe(a.key);
  });

  it("submit enqueues an indexnow_ping job with absolute deduped URLs", () => {
    const db = testDb();
    const svc = new IndexNowService(db);
    svc.submit(["/hello-world", "hello-world", "/other-post"]);

    const job = db.prepare("SELECT * FROM jobs WHERE type = 'indexnow_ping'").get() as any;
    expect(job).toBeTruthy();
    expect(JSON.parse(job.payload_json).urls).toEqual([
      `${config.publicUrl}/hello-world`,
      `${config.publicUrl}/other-post`,
    ]);
  });

  it("submit with no paths enqueues nothing", () => {
    const db = testDb();
    new IndexNowService(db).submit([]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM jobs").get()).toEqual({ c: 0 });
  });

  it("ping POSTs host, key, keyLocation and urlList to the endpoint", async () => {
    const db = testDb();
    const svc = new IndexNowService(db);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock as any;

    await svc.ping([`${config.publicUrl}/hello-world`]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(config.indexNow.endpoint);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      host: new URL(config.siteUrl).host,
      key: svc.key,
      keyLocation: `${config.publicUrl}/${svc.key}.txt`,
      urlList: [`${config.publicUrl}/hello-world`],
    });
  });

  it("ping accepts 202 and throws on other statuses so the job retries", async () => {
    const db = testDb();
    const svc = new IndexNowService(db);

    global.fetch = vi.fn().mockResolvedValue({ status: 202 }) as any;
    await expect(svc.ping(["https://example.com/a"])).resolves.toBeUndefined();

    global.fetch = vi
      .fn()
      .mockResolvedValue({ status: 403, text: () => Promise.resolve("Forbidden") }) as any;
    await expect(svc.ping(["https://example.com/a"])).rejects.toThrow(/HTTP 403/);
  });

  it("ping with an empty list is a no-op", async () => {
    const db = testDb();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    await new IndexNowService(db).ping([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
