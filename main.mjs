import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DOWNLOAD_INDEX_URL = "https://ziglang.org/download/index.json";
const COMMUNITY_MIRRORS_URL =
  "https://ziglang.org/download/community-mirrors.txt";
const DOWNLOAD_SOURCE = "github-vercel-labs-actions-setup-zig";
const USER_AGENT = "vercel-labs/actions-setup-zig";

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

  const artifact = release[target];
  if (!artifact?.tarball || !artifact?.shasum) {
    throw new Error(
      `Zig ${requestedVersion} does not publish a binary for ${target}`,
    );
  }

  return {
    artifact,
    version: release.version,
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

async function fetchText(url, timeoutMilliseconds = 30_000) {
  const response = await fetchResponse(url, timeoutMilliseconds);
  return response.text();
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

async function downloadFile(url, destination) {
  const response = await fetchResponse(url, 5 * 60_000);
  if (!response.body) {
    throw new Error("The response did not contain a body");
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: "wx" }),
  );
}

export async function sha256(filename) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filename), hash);
  return hash.digest("hex");
}

async function downloadVerified(officialUrl, expectedChecksum, destination) {
  const urls = await candidateUrls(officialUrl);
  const failures = [];

  for (const url of urls) {
    try {
      await fs.rm(destination, { force: true });
      info(`Downloading Zig from ${new URL(url).origin}`);
      await downloadFile(url, destination);

      const actualChecksum = await sha256(destination);
      if (actualChecksum !== expectedChecksum.toLowerCase()) {
        throw new Error(
          `SHA-256 mismatch (expected ${expectedChecksum}, received ${actualChecksum})`,
        );
      }

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

async function pathExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
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
  const executable = path.join(
    installDirectory,
    hostPlatform() === "win32" ? "zig.exe" : "zig",
  );

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
    (await pathExists(path.join(requestedInstallDirectory, ".complete")))
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

  if (await pathExists(completeMarker)) {
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
    await downloadVerified(artifact.tarball, artifact.shasum, archive);
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
    await fs.writeFile(completeMarker, `${version}${EOL}`, "utf8");
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
