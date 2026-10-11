// Publishing is only for versions set by `changeset version`: never the 0.0.0 placeholder
import { readFileSync } from "node:fs";

const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (version === "0.0.0") {
  console.error(`${name} is still at 0.0.0: add a changeset and merge the "Version Packages" pull request first.`);
  process.exit(1);
}
