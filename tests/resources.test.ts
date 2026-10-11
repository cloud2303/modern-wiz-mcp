import assert from "node:assert/strict";
import { test } from "node:test";
import { WizError } from "../src/errors.js";
import { prepareImage, resourceHash } from "../src/wiz/resources.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("image bytes are sniffed and hashed as base64url sha256", async () => {
  const file = await prepareImage({ contentBase64: png.toString("base64"), alt: "示例" });
  assert.equal(file.mime, "image/png");
  assert.equal(file.fileName, "示例.png");
  assert.equal(resourceHash(png), resourceHash(file.bytes));
  assert.match(resourceHash(png), /^[A-Za-z0-9_-]+$/);
  await assert.rejects(prepareImage({ contentBase64: Buffer.from("not-an-image").toString("base64") }),
    (error: unknown) => error instanceof WizError && error.code === "INVALID_INPUT");
});

test("a redirect onto a private host is rejected before the image is read", async () => {
  let reads = 0;
  await assert.rejects(prepareImage({
    url: "https://cdn.example/pic.png",
    lookup: async () => ["93.184.216.34"],
    fetch: async url => {
      reads++;
      if (String(url) === "https://cdn.example/pic.png") return new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/secret.png" } });
      return new Response(png);
    },
  }), (error: unknown) => error instanceof WizError && error.code === "INVALID_INPUT");
  assert.equal(reads, 1);
});
