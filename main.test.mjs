import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactFor,
  sha256,
  shuffled,
  targetFor,
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
