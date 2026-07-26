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
import { setTimeout as delay } from "node:timers/promises";

import {
  acquireInstallationLock,
  artifactFor,
  candidateDownloadsFor,
  configureProxyFromEnvironment,
  downloadFile,
  hasUsableCachedInstallation,
  sha256,
  shuffled,
  targetFor,
  verifyMinisign,
} from "./main.mjs";

test("enables Node proxy support from standard runner variables", () => {
  const environment = {
    https_proxy: "http://proxy.example.test:8080",
    no_proxy: "localhost",
  };
  let configuredEnvironment;

  assert.equal(
    configureProxyFromEnvironment(environment, (value) => {
      configuredEnvironment = value;
    }),
    true,
  );
  assert.equal(configuredEnvironment, environment);
  assert.equal(configureProxyFromEnvironment({}, assert.fail), false);
  assert.equal(
    configureProxyFromEnvironment(
      {
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NODE_USE_ENV_PROXY: "1",
      },
      assert.fail,
    ),
    false,
  );
  assert.throws(
    () => configureProxyFromEnvironment(environment, null),
    /cannot enable them dynamically/,
  );
});

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
        size: "3",
        tarball: "https://example.test/zig.tar.xz",
        shasum: "abc123",
      },
    },
  };

  assert.deepEqual(artifactFor(index, "0.16.0", "aarch64-macos"), {
    version: "0.16.0",
    artifact: {
      size: "3",
      tarball: "https://example.test/zig.tar.xz",
      shasum: "abc123",
    },
  });
});

test("uses the requested version when legacy index entries omit version", () => {
  const artifact = {
    size: "3",
    tarball: "https://example.test/zig.tar.xz",
    shasum: "abc123",
  };

  assert.deepEqual(
    artifactFor(
      { "0.15.1": { "x86_64-linux": artifact } },
      "0.15.1",
      "x86_64-linux",
    ),
    {
      artifact,
      version: "0.15.1",
    },
  );
});

test("requires master index entries to provide a resolved version", () => {
  assert.throws(
    () =>
      artifactFor(
        {
          master: {
            "x86_64-linux": {
              size: "3",
              tarball: "https://example.test/zig.tar.xz",
              shasum: "abc123",
            },
          },
        },
        "master",
        "x86_64-linux",
      ),
    /resolved version/,
  );
});

test("rejects a stable index entry that resolves to another version", () => {
  assert.throws(
    () =>
      artifactFor(
        {
          "0.16.0": {
            version: "0.15.1",
            "x86_64-linux": {
              size: "3",
              tarball: "https://example.test/zig.tar.xz",
              shasum: "abc123",
            },
          },
        },
        "0.16.0",
        "x86_64-linux",
      ),
    /resolved 0\.16\.0 as 0\.15\.1/,
  );
});

test("selects legacy ARM and x86 target aliases", () => {
  const armArtifact = {
    size: "3",
    tarball: "https://example.test/zig-armv7a.tar.xz",
    shasum: "arm",
  };
  const x86Artifact = {
    size: "3",
    tarball: "https://example.test/zig-i386.tar.xz",
    shasum: "x86",
  };
  const index = {
    "0.10.0": {
      "armv7a-linux": armArtifact,
      "i386-linux": x86Artifact,
    },
  };

  assert.equal(
    artifactFor(index, "0.10.0", "arm-linux").artifact,
    armArtifact,
  );
  assert.equal(
    artifactFor(index, "0.10.0", "x86-linux").artifact,
    x86Artifact,
  );
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

test("rejects invalid archive sizes in the download index", () => {
  assert.throws(
    () =>
      artifactFor(
        {
          "0.16.0": {
            "x86_64-linux": {
              size: "unknown",
              tarball: "https://example.test/zig.tar.xz",
              shasum: "abc123",
            },
          },
        },
        "0.16.0",
        "x86_64-linux",
      ),
    /invalid archive size/,
  );
});

test("shuffles without modifying the input", () => {
  const input = ["a", "b", "c"];
  assert.deepEqual(shuffled(input, () => 0), ["b", "c", "a"]);
  assert.deepEqual(input, ["a", "b", "c"]);
});

test("caps community mirrors and preserves the official fallback", () => {
  const officialUrl =
    "https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz";
  const candidates = candidateDownloadsFor(
    officialUrl,
    [
      "https://one.example.test/zig",
      "https://two.example.test/zig",
      "http://insecure.example.test/zig",
      "not a URL",
      "https://three.example.test/zig",
      "https://four.example.test/zig",
      "",
    ].join("\r\n"),
    () => 0,
  );

  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.at(-1), {
    timeoutMilliseconds: 5 * 60_000,
    url: officialUrl,
  });
  for (const candidate of candidates.slice(0, -1)) {
    const url = new URL(candidate.url);
    assert.equal(candidate.timeoutMilliseconds, 2 * 60_000);
    assert.equal(
      path.posix.basename(url.pathname),
      "zig-x86_64-linux-0.16.0.tar.xz",
    );
    assert.equal(url.searchParams.get("source"), "github-vercel-labs-setup-zig");
  }
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

test("enforces the expected download size while streaming", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "setup-zig-test-"));
  const exactFile = path.join(directory, "exact");
  const oversizedFile = path.join(directory, "oversized");
  const undersizedFile = path.join(directory, "undersized");
  const url = "data:application/octet-stream;base64,emln";

  try {
    await downloadFile(url, exactFile, 3);
    assert.equal(await fs.readFile(exactFile, "utf8"), "zig");
    await assert.rejects(
      downloadFile(url, oversizedFile, 2),
      /exceeds 2 bytes/,
    );
    await assert.rejects(
      downloadFile(url, undersizedFile, 4),
      /contained 3 bytes, expected 4/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not mutate an invalid cache entry before publication", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "setup-zig-test-"));
  const installDirectory = path.join(directory, "install");
  await fs.mkdir(installDirectory);
  await fs.writeFile(
    path.join(installDirectory, ".complete"),
    "minisign-v1:0.16.0\n",
  );

  try {
    assert.equal(
      await hasUsableCachedInstallation(installDirectory, "0.16.0"),
      false,
    );
    await fs.access(installDirectory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("serializes installation publication with a recoverable lock", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "setup-zig-test-"));
  const lockDirectory = path.join(directory, "install.lock");
  const options = {
    pollMilliseconds: 5,
    staleAfterMilliseconds: 1_000,
    waitTimeoutMilliseconds: 1_000,
  };

  try {
    const releaseFirst = await acquireInstallationLock(lockDirectory, options);
    let secondAcquired = false;
    const secondLock = acquireInstallationLock(lockDirectory, options).then(
      (release) => {
        secondAcquired = true;
        return release;
      },
    );

    await delay(25);
    assert.equal(secondAcquired, false);
    await releaseFirst();

    const releaseSecond = await secondLock;
    assert.equal(secondAcquired, true);
    await releaseSecond();

    await fs.mkdir(lockDirectory);
    const staleTime = new Date(Date.now() - 2_000);
    await fs.utimes(lockDirectory, staleTime, staleTime);
    const releaseRecovered = await acquireInstallationLock(
      lockDirectory,
      options,
    );
    await releaseRecovered();
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
