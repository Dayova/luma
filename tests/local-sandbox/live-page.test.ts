import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { livePage } from "../../src/local-sandbox/live-page.js";

class Element {
  value = "";
  textContent = "";
  className = "";
  disabled = false;
  dataset = {};
  onclick: () => unknown = () => undefined;
  append() {}
  replaceChildren() {}
  focus() {}
}
const view = { connected: true, model: "test", usage: {}, meetings: [] };
const credential = "test-only-read-credential";
async function page(
  command: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>
) {
  const elements = new Map(
    [...livePage.matchAll(/id="([^"]+)"/gu)].map((m) => [m[1]!, new Element()])
  );
  let commands = 0;
  runInNewContext(livePage.split("<script>")[1]!.split("</script>")[0]!, {
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: () => new Element(),
      querySelectorAll: () => [],
      addEventListener() {}
    },
    fetch: async (path: string) => {
      if (path === "/api/state") return { ok: true, json: () => Promise.resolve(view) };
      commands++;
      return command();
    },
    AbortSignal,
    setInterval() {}
  });
  await setImmediate();
  return { field: (id: string) => elements.get(id)!, commands: () => commands };
}
const success = () => Promise.resolve({ ok: true, json: () => Promise.resolve(view) });

it("keeps the pasted Linear token and shows a nearby error when Team UUID is missing", async () => {
  const ui = await page(success);
  ui.field("linear-token").value = credential;
  await ui.field("linear-connect").onclick();
  expect(ui.field("linear-token").value).toBe(credential);
  expect(ui.commands()).toBe(0);
  expect(ui.field("linear-feedback").textContent).toContain("Team UUID");
});

it.each(["domain", "http", "network"])(
  "preserves credentials on %s failure and reports it beside Apply",
  async (failure) => {
    const ui = await page(() => {
      if (failure === "network")
        return Promise.reject(new Error("test transport unavailable"));
      return Promise.resolve({
        ok: failure !== "http",
        json: () =>
          Promise.resolve(
            failure === "http"
              ? { error: "Server busy" }
              : { ...view, error: { message: "Connection rejected" } }
          )
      });
    });
    ui.field("linear-token").value = credential;
    ui.field("linear-scope").value = "63c160e7-ab70-4ef9-9822-0f85590ebb7f";
    await ui.field("linear-connect").onclick();
    expect(ui.commands()).toBe(1);
    expect(ui.field("linear-token").value).toBe(credential);
    expect(ui.field("linear-feedback").className).toBe("error");
    expect(ui.field("linear-feedback").textContent.length).toBeGreaterThan(5);
  }
);

it("clears the submitted credentials only after a successful apply and explains the next step", async () => {
  const ui = await page(success);
  ui.field("linear-token").value = credential;
  ui.field("linear-scope").value = "63c160e7-ab70-4ef9-9822-0f85590ebb7f";
  await ui.field("linear-connect").onclick();
  expect(ui.field("linear-token").value).toBe("");
  expect(ui.field("linear-feedback").textContent).toContain("Test Linear read");
});

it("does not erase a replacement token typed while the request is pending", async () => {
  let finish: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ui = await page(async () => {
    await pending;
    return success();
  });
  ui.field("key").value = credential;
  const request = ui.field("connect").onclick();
  ui.field("key").value = "replacement-test-credential";
  finish();
  await request;
  expect(ui.field("key").value).toBe("replacement-test-credential");
});

it("preserves the OpenAI key on a rejected connection", async () => {
  const ui = await page(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ...view, error: { message: "Invalid key" } })
    })
  );
  ui.field("key").value = credential;
  await ui.field("connect").onclick();
  expect(ui.field("key").value).toBe(credential);
  expect(ui.field("key-feedback").textContent).toBe("Invalid key");
});

it.each(["notion", "github"])(
  "retains the %s token when its resource scope is missing",
  async (provider) => {
    const ui = await page(success);
    ui.field(provider + "-token").value = credential;
    await ui.field(provider + "-connect").onclick();
    expect(ui.commands()).toBe(0);
    expect(ui.field(provider + "-token").value).toBe(credential);
    expect(ui.field(provider + "-feedback").className).toBe("error");
  }
);
