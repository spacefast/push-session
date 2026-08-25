import fs from "node:fs";
import path from "node:path";

export function writeArtifactBundle(bundle, outputDirectory, options = {}) {
  const root = path.resolve(outputDirectory);
  if (fs.existsSync(root)) {
    const entries = fs.readdirSync(root);
    if (entries.length > 0 && !options.force) {
      throw new Error(`Output directory is not empty: ${root}. Use --force to overwrite generated paths.`);
    }
  }
  fs.mkdirSync(root, { recursive: true });
  const prefix = `${bundle.basePath}/`;
  const written = [];
  for (const file of bundle.files) {
    const relative = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
    const target = safeTarget(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    written.push(target);
  }
  return { outputDirectory: root, entryPath: path.join(root, "index.html"), files: written };
}

function safeTarget(root, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`Invalid artifact output path: ${relativePath}`);
  }
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Artifact output escapes the target directory: ${relativePath}`);
  }
  return target;
}
