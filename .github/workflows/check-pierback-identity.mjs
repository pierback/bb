import { execFileSync } from "node:child_process";

const revisions = process.argv.slice(2);
const revisionArgs = revisions.length > 0 ? revisions : ["HEAD"];
const recordSeparator = "\u001e";
const fieldSeparator = "\u001f";

const output = execFileSync(
  "git",
  [
    "log",
    `--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1e`,
    ...revisionArgs,
  ],
  { encoding: "utf8" },
);

const violations = output
  .split(recordSeparator)
  .map((record) => record.trim())
  .filter(Boolean)
  .flatMap((record) => {
    const [sha, authorName, authorEmail, committerName, committerEmail] =
      record.split(fieldSeparator);
    const identities = [
      ["author", authorName, authorEmail],
      ["committer", committerName, committerEmail],
    ];

    return identities.flatMap(([role, name, email]) => {
      const reasons = [];
      if (name.toLowerCase().includes("celofab")) {
        reasons.push("celofab identity");
      }
      if (email.toLowerCase().endsWith("@celonis.com")) {
        reasons.push("Celonis email");
      }

      return reasons.map((reason) => ({ sha, role, name, email, reason }));
    });
  });

if (violations.length > 0) {
  console.error("Pierback commit identity policy failed:");
  for (const violation of violations) {
    console.error(
      `- ${violation.sha} ${violation.role} ${violation.name} <${violation.email}> (${violation.reason})`,
    );
  }
  process.exit(1);
}

console.log(
  `Pierback commit identity policy passed for ${revisionArgs.join(" ")}.`,
);
