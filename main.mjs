import { spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  promises as fs,
} from "node:fs";
import {
  EOL,
  arch as hostArch,
  endianness,
  platform as hostPlatform,
  tmpdir,
} from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DOWNLOAD_INDEX_URL = "https://ziglang.org/download/index.json";
const COMMUNITY_MIRRORS_URL =
  "https://ziglang.org/download/community-mirrors.txt";
const DOWNLOAD_SOURCE = "github-vercel-labs-setup-zig";
const USER_AGENT = "vercel-labs/setup-zig";
const ZIG_MINISIGN_PUBLIC_KEY =
  "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const CACHE_MARKER_FORMAT = "minisign-v1";

function actionInput(name) {
  return process.env[`INPUT_${name.replaceAll("-", "_").toUpperCase()}`]?.trim();
}

function workflowCommand(command, message) {
  const escaped = String(message)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.log(`::${command}::${escaped}`);
}

function info(message) {
  console.log(message);
}

function warning(message) {
  workflowCommand("warning", message);
}

function debug(message) {
  if (process.env.ACTIONS_STEP_DEBUG === "true") {
    workflowCommand("debug", message);
  }
}

async function appendWorkflowFile(environmentVariable, line) {
  const filename = process.env[environmentVariable];
  if (!filename) {
    debug(`${environmentVariable} is not set; skipped writing "${line}"`);
    return;
  }

  await fs.appendFile(filename, `${line}${EOL}`, "utf8");
}

async function setOutput(name, value) {
  await appendWorkflowFile("GITHUB_OUTPUT", `${name}=${value}`);
}

async function addPath(directory) {
  process.env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? ""}`;
  await appendWorkflowFile("GITHUB_PATH", directory);
}

export function targetFor(
  platform = hostPlatform(),
  architecture = hostArch(),
  byteOrder = endianness(),
) {
  const platformNames = {
    darwin: "macos",
    freebsd: "freebsd",
    linux: "linux",
    netbsd: "netbsd",
    openbsd: "openbsd",
    win32: "windows",
  };
  const architectureNames = {
    arm: "arm",
    arm64: "aarch64",
    ia32: "x86",
    loong64: "loongarch64",
    riscv64: "riscv64",
    s390x: "s390x",
    x64: "x86_64",
  };

  const zigPlatform = platformNames[platform];
  const zigArchitecture =
    architecture === "ppc64" && byteOrder === "LE"
      ? "powerpc64le"
      : architectureNames[architecture];
  if (!zigPlatform || !zigArchitecture) {
    throw new Error(
      `Unsupported runner platform: ${platform}/${architecture} (${byteOrder})`,
    );
  }

  return `${zigArchitecture}-${zigPlatform}`;
}

export function artifactFor(index, requestedVersion, target) {
  const release = index[requestedVersion];
  if (!release) {
    throw new Error(
      `Zig version "${requestedVersion}" was not found in the official download index`,
    );
  }

  const [architecture, ...platformParts] = target.split("-");
  const platform = platformParts.join("-");
  const compatibleTargets = [target];
  if (architecture === "arm") {
    compatibleTargets.push(`armv7a-${platform}`, `armv6kz-${platform}`);
  } else if (architecture === "x86") {
    compatibleTargets.push(`i386-${platform}`);
  }

  const artifact = compatibleTargets
    .map((compatibleTarget) => release[compatibleTarget])
    .find((candidate) => candidate?.tarball && candidate?.shasum);
  if (!artifact?.tarball || !artifact?.shasum) {
    throw new Error(
      `Zig ${requestedVersion} does not publish a binary for ${target}`,
    );
  }

  const size = Number(artifact.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(
      `Zig ${requestedVersion} publishes an invalid archive size for ${target}`,
    );
  }

  let version = requestedVersion;
  if (requestedVersion === "master") {
    if (typeof release.version !== "string" || !release.version) {
      throw new Error(
        "Zig's download index did not provide a resolved version for master",
      );
    }
    version = release.version;
  } else if (
    release.version !== undefined &&
    release.version !== requestedVersion
  ) {
    throw new Error(
      `Zig's download index resolved ${requestedVersion} as ${release.version}`,
    );
  }

  return {
    artifact,
    version,
  };
}

async function fetchResponse(url, timeoutMilliseconds) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response;
}

async function fetchText(
  url,
  timeoutMilliseconds = 30_000,
  maximumBytes = 2 * 1024 * 1024,
) {
  const response = await fetchResponse(url, timeoutMilliseconds);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`Response from ${url} exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) {
    throw new Error(`Response from ${url} did not contain a body`);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) {
      throw new Error(`Response from ${url} exceeds ${maximumBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchDownloadIndex() {
  const text = await fetchText(DOWNLOAD_INDEX_URL);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Zig returned an invalid download index: ${error.message}`);
  }
}

export function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const otherIndex = Math.floor(random() * (index + 1));
    [result[index], result[otherIndex]] = [result[otherIndex], result[index]];
  }
  return result;
}

async function candidateUrls(officialUrl) {
  const archiveName = path.posix.basename(new URL(officialUrl).pathname);
  let mirrors = [];

  try {
    const mirrorList = await fetchText(COMMUNITY_MIRRORS_URL);
    mirrors = shuffled(
      mirrorList
        .split("\n")
        .filter(Boolean)
        .filter((url) => url.startsWith("https://")),
    ).map((mirror) => {
      const url = new URL(`${mirror.replace(/\/$/, "")}/${archiveName}`);
      url.searchParams.set("source", DOWNLOAD_SOURCE);
      return url.href;
    });
  } catch (error) {
    warning(`Could not load Zig's community mirror list: ${error.message}`);
  }

  return [...mirrors, officialUrl];
}

export async function downloadFile(url, destination, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error(`Invalid expected download size: ${expectedBytes}`);
  }

  const response = await fetchResponse(url, 5 * 60_000);
  if (!response.body) {
    throw new Error("The response did not contain a body");
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentEncoding = response.headers.get("content-encoding");
  if (
    contentLengthHeader !== null &&
    (!contentEncoding || contentEncoding === "identity")
  ) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error(`Response from ${url} has an invalid Content-Length`);
    }
    if (contentLength > expectedBytes) {
      throw new Error(`Response from ${url} exceeds ${expectedBytes} bytes`);
    }
  }

  let downloadedBytes = 0;
  const byteLimiter = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > expectedBytes) {
        callback(
          new Error(`Response from ${url} exceeds ${expectedBytes} bytes`),
        );
        return;
      }
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body),
    byteLimiter,
    createWriteStream(destination, { flags: "wx" }),
  );
  if (downloadedBytes !== expectedBytes) {
    throw new Error(
      `Response from ${url} contained ${downloadedBytes} bytes, expected ${expectedBytes}`,
    );
  }
}

export async function sha256(filename) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filename), hash);
  return hash.digest("hex");
}

function decodeBase64(value, label) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error(`Invalid base64 in minisign ${label}`);
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`Non-canonical base64 in minisign ${label}`);
  }
  return decoded;
}

function parseMinisign(signatureText, publicKeyBase64) {
  if (Buffer.byteLength(signatureText, "utf8") > 16 * 1024) {
    throw new Error("Minisign signature file is unexpectedly large");
  }

  const lines = signatureText.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  ) {
    throw new Error("Invalid minisign signature file format");
  }

  const publicKeyPacket = decodeBase64(publicKeyBase64, "public key");
  const signaturePacket = decodeBase64(lines[1], "signature");
  const globalSignature = decodeBase64(lines[3], "global signature");
  if (publicKeyPacket.length !== 42) {
    throw new Error("Invalid minisign public key length");
  }
  if (signaturePacket.length !== 74) {
    throw new Error("Invalid minisign signature length");
  }
  if (globalSignature.length !== 64) {
    throw new Error("Invalid minisign global signature length");
  }
  if (publicKeyPacket.subarray(0, 2).toString("ascii") !== "Ed") {
    throw new Error("Unsupported minisign public key algorithm");
  }
  if (signaturePacket.subarray(0, 2).toString("ascii") !== "ED") {
    throw new Error("Zig archive does not use a prehashed minisign signature");
  }

  const publicKeyId = publicKeyPacket.subarray(2, 10);
  const signatureKeyId = signaturePacket.subarray(2, 10);
  if (!timingSafeEqual(publicKeyId, signatureKeyId)) {
    throw new Error("Minisign signature was made with an unexpected key");
  }

  const publicKey = createPublicKey({
    format: "der",
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyPacket.subarray(10)]),
    type: "spki",
  });

  return {
    globalSignature,
    publicKey,
    signature: signaturePacket.subarray(10),
    trustedComment: lines[2].slice("trusted comment: ".length),
  };
}

export async function verifyMinisign(
  filename,
  signatureText,
  expectedArchiveName,
  publicKeyBase64 = ZIG_MINISIGN_PUBLIC_KEY,
) {
  const { globalSignature, publicKey, signature, trustedComment } =
    parseMinisign(signatureText, publicKeyBase64);
  const trustedCommentBytes = Buffer.from(trustedComment, "utf8");

  if (
    !verifySignature(
      null,
      Buffer.concat([signature, trustedCommentBytes]),
      publicKey,
      globalSignature,
    )
  ) {
    throw new Error("Minisign trusted comment signature verification failed");
  }

  const trustedCommentFields = trustedComment.split("\t");
  const signedFileFields = trustedCommentFields.filter((field) =>
    field.startsWith("file:"),
  );
  if (signedFileFields.length !== 1) {
    throw new Error("Minisign trusted comment does not contain one file field");
  }
  const signedArchiveName = signedFileFields[0].slice("file:".length);
  if (signedArchiveName !== expectedArchiveName) {
    throw new Error(
      `Minisign signature is for "${signedArchiveName}", expected "${expectedArchiveName}"`,
    );
  }
  if (!trustedCommentFields.includes("hashed")) {
    throw new Error("Minisign trusted comment does not mark the file as hashed");
  }

  const digest = createHash("blake2b512");
  await pipeline(createReadStream(filename), digest);
  if (!verifySignature(null, digest.digest(), publicKey, signature)) {
    throw new Error("Minisign archive signature verification failed");
  }
}

function signatureUrlFor(archiveUrl) {
  const signatureUrl = new URL(archiveUrl);
  signatureUrl.pathname = `${signatureUrl.pathname}.minisig`;
  return signatureUrl.href;
}

async function downloadVerified(
  officialUrl,
  expectedChecksum,
  expectedBytes,
  destination,
) {
  const urls = await candidateUrls(officialUrl);
  const failures = [];
  const archiveName = path.posix.basename(new URL(officialUrl).pathname);

  for (const url of urls) {
    try {
      await fs.rm(destination, { force: true });
      info(`Downloading Zig from ${new URL(url).origin}`);
      await downloadFile(url, destination, expectedBytes);
      const signatureText = await fetchText(
        signatureUrlFor(url),
        30_000,
        16 * 1024,
      );

      const actualChecksum = await sha256(destination);
      if (actualChecksum !== expectedChecksum.toLowerCase()) {
        throw new Error(
          `SHA-256 mismatch (expected ${expectedChecksum}, received ${actualChecksum})`,
        );
      }
      await verifyMinisign(destination, signatureText, archiveName);
      info("Zig checksum and minisign signature verified");

      return;
    } catch (error) {
      failures.push(`${new URL(url).origin}: ${error.message}`);
      warning(`Zig download attempt failed: ${failures.at(-1)}`);
    }
  }

  throw new Error(`Unable to download Zig:\n${failures.join("\n")}`);
}

async function run(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };

      if (code === 0) {
        resolve(result);
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}: ${result.stderr || result.stdout}`,
          ),
        );
      }
    });
  });
}

async function extractArchive(archive, destination) {
  await fs.mkdir(destination, { recursive: true });
  await run("tar", [
    "-xf",
    archive,
    "-C",
    destination,
    "--strip-components",
    "1",
  ]);
}

async function validateInstallation(zigPath, expectedVersion) {
  const result = await run(zigPath, ["version"]);
  const actualVersion = result.stdout.trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Installed Zig reported version "${actualVersion}", expected "${expectedVersion}"`,
    );
  }
}

async function hasVerifiedCacheMarker(installDirectory, version) {
  try {
    const marker = await fs.readFile(
      path.join(installDirectory, ".complete"),
      "utf8",
    );
    return marker.trim() === `${CACHE_MARKER_FORMAT}:${version}`;
  } catch {
    return false;
  }
}

function executableFor(installDirectory) {
  return path.join(
    installDirectory,
    hostPlatform() === "win32" ? "zig.exe" : "zig",
  );
}

export async function hasUsableCachedInstallation(installDirectory, version) {
  if (!(await hasVerifiedCacheMarker(installDirectory, version))) {
    return false;
  }

  try {
    await validateInstallation(executableFor(installDirectory), version);
    return true;
  } catch (error) {
    warning(
      `Cached Zig ${version} is invalid and will be replaced: ${error.message}`,
    );
    await fs.rm(installDirectory, { force: true, recursive: true });
    return false;
  }
}

async function moveDirectory(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }

    await fs.cp(source, destination, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    await fs.rm(source, { force: true, recursive: true });
  }
}

async function publishInstallation(installDirectory, version, cacheHit) {
  const executable = executableFor(installDirectory);

  await validateInstallation(executable, version);
  await addPath(installDirectory);
  await setOutput("version", version);
  await setOutput("zig-path", executable);
  await setOutput("cache-hit", String(cacheHit));

  info(`Zig ${version} is ready`);
}

export async function setup() {
  const requestedVersion = actionInput("version") || "0.16.0";
  if (
    !/^(?:master|\d+\.\d+\.\d+(?:-dev\.\d+\+[0-9A-Za-z]+)?)$/.test(
      requestedVersion,
    )
  ) {
    throw new Error(`Invalid Zig version: "${requestedVersion}"`);
  }

  const target = targetFor();
  info(`Resolving Zig ${requestedVersion} for ${target}`);

  const cacheRoot =
    process.env.RUNNER_TOOL_CACHE ??
    path.join(tmpdir(), "vercel-labs-actions-tool-cache");
  const requestedInstallDirectory = path.join(
    cacheRoot,
    "zig",
    requestedVersion,
    target,
  );
  if (
    requestedVersion !== "master" &&
    (await hasUsableCachedInstallation(
      requestedInstallDirectory,
      requestedVersion,
    ))
  ) {
    await publishInstallation(
      requestedInstallDirectory,
      requestedVersion,
      true,
    );
    return;
  }

  const index = await fetchDownloadIndex();
  const { artifact, version } = artifactFor(index, requestedVersion, target);
  const installDirectory = path.join(cacheRoot, "zig", version, target);
  const completeMarker = path.join(installDirectory, ".complete");

  if (await hasUsableCachedInstallation(installDirectory, version)) {
    await publishInstallation(installDirectory, version, true);
    return;
  }

  const runnerTemp = process.env.RUNNER_TEMP ?? tmpdir();
  const temporaryDirectory = await fs.mkdtemp(
    path.join(runnerTemp, "setup-zig-"),
  );
  const archiveName = path.basename(new URL(artifact.tarball).pathname);
  const archive = path.join(temporaryDirectory, archiveName);
  const stagingDirectory = path.join(temporaryDirectory, "install");

  try {
    await downloadVerified(
      artifact.tarball,
      artifact.shasum,
      Number(artifact.size),
      archive,
    );
    info("Extracting Zig");
    await extractArchive(archive, stagingDirectory);

    const stagedExecutable = path.join(
      stagingDirectory,
      hostPlatform() === "win32" ? "zig.exe" : "zig",
    );
    if (hostPlatform() !== "win32") {
      await fs.chmod(stagedExecutable, 0o755);
    }
    await validateInstallation(stagedExecutable, version);

    await fs.mkdir(path.dirname(installDirectory), { recursive: true });
    await fs.rm(installDirectory, { recursive: true, force: true });
    await moveDirectory(stagingDirectory, installDirectory);
    await fs.writeFile(
      completeMarker,
      `${CACHE_MARKER_FORMAT}:${version}${EOL}`,
      "utf8",
    );
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }

  await publishInstallation(installDirectory, version, false);
}

async function main() {
  try {
    await setup();
  } catch (error) {
    if (process.env.ACTIONS_STEP_DEBUG === "true" && error?.stack) {
      console.error(error.stack);
    }
    workflowCommand("error", error?.message ?? String(error));
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  await main();
}
