import fs from "node:fs";
import path from "node:path";

export function writeArtifactBundle(bundle, outputDirectory, options = {}) {
  const root = path.resolve(outputDirectory);
  const prefix = `${bundle.basePath}/`;
  const targets = bundle.files.map((file) => {
    if (!file.path.startsWith(prefix)) throw new Error(`Artifact file is outside the bundle: ${file.path}`);
    return { file, target: safeTarget(root, file.path.slice(prefix.length)) };
  });
  if (fs.existsSync(root)) {
    if (!fs.lstatSync(root).isDirectory()) throw new Error(`Output is not a directory: ${root}`);
    const entries = fs.readdirSync(root);
    if (entries.length > 0 && !options.force) {
      throw new Error(`Output directory is not empty: ${root}. Use --force to overwrite generated paths.`);
    }
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const written = [];
  for (const { file, target } of targets) {
    ensureSafeDirectory(root, path.dirname(target));
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${target}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW |
      (options.force ? fs.constants.O_TRUNC : fs.constants.O_EXCL);
    const descriptor = fs.openSync(target, flags, 0o600);
    try {
      fs.writeFileSync(descriptor, file.content);
    } finally {
      fs.closeSync(descriptor);
    }
    written.push(target);
  }
  return { outputDirectory: root, entryPath: path.join(root, "index.html"), files: written };
}

function ensureSafeDirectory(root, directory) {
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory()) throw new Error(`Refusing to write through a non-directory: ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
}

function safeTarget(root, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid artifact output path: ${relativePath}`);
  }
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Artifact output escapes the target directory: ${relativePath}`);
  }
  return target;
}
