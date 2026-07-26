import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as createSignature,
} from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactFor,
  sha256,
  shuffled,
  targetFor,
  verifyMinisign,
} from "./main.mjs";

test("maps runner platforms to Zig targets", () => {
  assert.equal(targetFor("linux", "x64"), "x86_64-linux");
  assert.equal(targetFor("darwin", "arm64"), "aarch64-macos");
  assert.equal(targetFor("win32", "x64"), "x86_64-windows");
  assert.equal(targetFor("linux", "ppc64", "LE"), "powerpc64le-linux");
});

test("rejects unsupported runner platforms", () => {
  assert.throws(
    () => targetFor("aix", "x64"),
    /Unsupported runner platform/,
  );
});

test("selects a versioned artifact from the download index", () => {
  const index = {
    "0.16.0": {
      version: "0.16.0",
      "aarch64-macos": {
        tarball: "https://example.test/zig.tar.xz",
        shasum: "abc123",
      },
    },
  };

  assert.deepEqual(artifactFor(index, "0.16.0", "aarch64-macos"), {
    version: "0.16.0",
    artifact: {
      tarball: "https://example.test/zig.tar.xz",
      shasum: "abc123",
    },
  });
});

test("reports missing versions and targets clearly", () => {
  assert.throws(
    () => artifactFor({}, "0.16.0", "x86_64-linux"),
    /was not found/,
  );
  assert.throws(
    () =>
      artifactFor(
        { "0.16.0": { version: "0.16.0" } },
        "0.16.0",
        "x86_64-linux",
      ),
    /does not publish a binary/,
  );
});

test("shuffles without modifying the input", () => {
  const input = ["a", "b", "c"];
  assert.deepEqual(shuffled(input, () => 0), ["b", "c", "a"]);
  assert.deepEqual(input, ["a", "b", "c"]);
});

test("computes a file SHA-256 checksum", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "setup-zig-test-"));
  const filename = path.join(directory, "fixture.txt");

  try {
    await fs.writeFile(filename, "zig");
    assert.equal(
      await sha256(filename),
      "77ebfe9993f116e089f21a982b4afcb67e3761529a29b52d5c88c65b467514e4",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function minisignFixture(directory, archiveName) {
  const archive = path.join(directory, archiveName);
  const contents = Buffer.from("signed Zig archive fixture");
  await fs.writeFile(archive, contents);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const keyId = Buffer.from("0123456789abcdef", "hex");
  const publicKeyPacket = Buffer.concat([
    Buffer.from("Ed"),
    keyId,
    publicKeyBytes,
  ]);

  const digest = createHash("blake2b512").update(contents).digest();
  const signature = createSignature(null, digest, privateKey);
  const signaturePacket = Buffer.concat([
    Buffer.from("ED"),
    keyId,
    signature,
  ]);
  const trustedComment = `timestamp:1\tfile:${archiveName}\thashed`;
  const globalSignature = createSignature(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment)]),
    privateKey,
  );
  const signatureText = [
    "untrusted comment: test signature",
    signaturePacket.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n");

  return {
    archive,
    publicKey: publicKeyPacket.toString("base64"),
    signatureText,
  };
}

test("verifies a prehashed minisign signature and signed filename", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "setup-zig-test-"));

  try {
    const fixture = await minisignFixture(directory, "zig.tar.xz");
    await verifyMinisign(
      fixture.archive,
      fixture.signatureText,
      "zig.tar.xz",
      fixture.publicKey,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects a minisign signature for another filename", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "setup-zig-test-"));

  try {
    const fixture = await minisignFixture(directory, "zig.tar.xz");
    await assert.rejects(
      verifyMinisign(
        fixture.archive,
        fixture.signatureText,
        "other.tar.xz",
        fixture.publicKey,
      ),
      /signature is for/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects tampered archives and trusted comments", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "setup-zig-test-"));

  try {
    const fixture = await minisignFixture(directory, "zig.tar.xz");
    await fs.appendFile(fixture.archive, "tampered");
    await assert.rejects(
      verifyMinisign(
        fixture.archive,
        fixture.signatureText,
        "zig.tar.xz",
        fixture.publicKey,
      ),
      /archive signature verification failed/,
    );

    const tamperedComment = fixture.signatureText.replace(
      "timestamp:1",
      "timestamp:2",
    );
    await assert.rejects(
      verifyMinisign(
        fixture.archive,
        tamperedComment,
        "zig.tar.xz",
        fixture.publicKey,
      ),
      /trusted comment signature verification failed/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
