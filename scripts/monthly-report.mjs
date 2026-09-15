#!/usr/bin/env node
// 月报生成器 — monthly-reports/YYYY-MM.md
//
//   node scripts/monthly-report.mjs [YYYY-MM] [--print]
//
// 行为约定（见 monthly-reports/README.md）：
//   1. 文件不存在时用 TEMPLATE.md 铺骨架；
//   2. 每次运行都重新统计 git 数据，只覆盖 AUTO:BEGIN / AUTO:END 之间的附录；
//   3. 标记之外的正文永不改写，所以可以随时重跑刷新数据。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(repoRoot, "monthly-reports");
const templatePath = path.join(reportDir, "TEMPLATE.md");
const AUTO_BEGIN = "<!-- AUTO:BEGIN -->";
const AUTO_END = "<!-- AUTO:END -->";
const FIELD_SEP = "";
const RECORD_SEP = "";

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  const rest = argv.filter((arg) => !arg.startsWith("--"));
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const month = rest[0] ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error(`月份格式应为 YYYY-MM，收到: ${month}`);
  }
  return { month, print: flags.has("--print") };
}

// git 的 --since/--until 按本机时区解释，换台机器或改时区结果会变。这里放宽 2 天取回，
// 再按提交自身时区的作者日期（%ad）精确筛月，保证同一份月报在任何机器上跑出同样的数字。
function monthRange(month) {
  const [year, mon] = month.split("-").map(Number);
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    since: iso(Date.UTC(year, mon - 1, 1) - 2 * day),
    until: iso(Date.UTC(year, mon, 1) + 2 * day),
  };
}

// 一次 git log 里同时拿提交头和它的文件清单，避免分两次调用时对不上号。
function logBlocks(month, extraArgs) {
  const { since, until } = monthRange(month);
  const output = git([
    "log",
    `--since=${since}`,
    `--until=${until}`,
    "--date=short",
    `--pretty=format:${RECORD_SEP}%H${FIELD_SEP}%ad${FIELD_SEP}%an${FIELD_SEP}%s`,
    ...extraArgs,
  ]);
  return output
    .split(RECORD_SEP)
    .filter((block) => block.trim())
    .map((block) => {
      const [header, ...rest] = block.split("\n");
      const [hash, date, author, subject] = header.split(FIELD_SEP);
      return {
        hash: (hash ?? "").slice(0, 8),
        date: date ?? "",
        author: author ?? "",
        subject: subject ?? "",
        files: rest.filter(Boolean),
      };
    })
    .filter((commit) => commit.date.startsWith(month));
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function collect(month) {
  const { since, until } = monthRange(month);

  const commits = logBlocks(month, ["--numstat"]).map((commit) => {
    const match = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(commit.subject);
    return {
      ...commit,
      type: match?.[1] ?? "(无前缀)",
      scope: match?.[2] ?? null,
      title: match?.[3] ?? commit.subject,
    };
  });

  let insertions = 0;
  let deletions = 0;
  const touched = new Set();
  const dirs = [];
  for (const commit of commits) {
    for (const line of commit.files) {
      const [added, removed, file] = line.split("\t");
      if (!file) continue;
      insertions += Number(added) || 0;
      deletions += Number(removed) || 0;
      touched.add(file);
      const parts = file.split("/");
      dirs.push(parts.length > 1 ? parts.slice(0, 2).join("/") : file);
    }
  }

  const addedFiles = logBlocks(month, ["--diff-filter=A", "--name-only"]).flatMap(
    (commit) => commit.files,
  );

  const releases = commits
    .filter((commit) => /release|publish|发布/i.test(commit.subject))
    .filter((commit) => /\d+\.\d+\.\d+/.test(commit.subject));

  return {
    month,
    fetchedSince: since,
    fetchedUntil: until,
    commits,
    insertions,
    deletions,
    filesTouched: touched.size,
    dirs: tally(dirs).slice(0, 12),
    types: tally(commits.map((commit) => commit.type)),
    scopes: tally(commits.map((commit) => commit.scope).filter(Boolean)).slice(0, 10),
    authors: tally(commits.map((commit) => commit.author)),
    releases,
    newTests: [...new Set(addedFiles.filter((file) => /^scripts\/test-.*\.(mjs|cjs)$/.test(file)))],
    newDocs: [...new Set(addedFiles.filter((file) => /^docs\/.*\.md$/.test(file)))],
  };
}

function renderAuto(data) {
  const lines = [];
  const push = (line = "") => lines.push(line);

  push(AUTO_BEGIN);
  push("<!-- 由 scripts/monthly-report.mjs 生成，请勿手工编辑 -->");
  push();
  push(`统计范围：${data.month} 全月（按提交自身时区的作者日期计）`);
  push();
  const authors = data.authors.map(([name, count]) => `${name}（${count}）`).join("、") || "—";
  push(`- 提交数：**${data.commits.length}**　参与者：${authors}`);
  push(`- 改动规模：${data.filesTouched} 个文件　+${data.insertions} / -${data.deletions} 行`);
  push(`- 新增测试脚本：${data.newTests.length} 个　新增设计/验收文档：${data.newDocs.length} 篇`);
  push();

  push("### 提交类型分布");
  push();
  push("| 类型 | 数量 |");
  push("|------|------|");
  for (const [type, count] of data.types) push(`| ${type} | ${count} |`);
  push();

  if (data.scopes.length) {
    push("### 主要改动范围（commit scope）");
    push();
    push("| scope | 数量 |");
    push("|-------|------|");
    for (const [scope, count] of data.scopes) push(`| ${scope} | ${count} |`);
    push();
  }

  push("### 改动最集中的目录");
  push();
  push("| 目录 | 文件改动次数 |");
  push("|------|--------------|");
  for (const [dir, count] of data.dirs) push(`| \`${dir}\` | ${count} |`);
  push();

  push("### 发版相关提交");
  push();
  if (data.releases.length) {
    push("| 日期 | 提交 | 说明 |");
    push("|------|------|------|");
    for (const release of data.releases) {
      push(`| ${release.date} | \`${release.hash}\` | ${release.subject} |`);
    }
  } else {
    push("本月无发版提交。");
  }
  push();

  if (data.newTests.length) {
    push("### 本月新增的测试脚本");
    push();
    for (const file of data.newTests) push(`- \`${file}\``);
    push();
  }

  if (data.newDocs.length) {
    push("### 本月新增的文档");
    push();
    for (const file of data.newDocs) push(`- \`${file}\``);
    push();
  }

  push(AUTO_END);
  return lines.join("\n");
}

function main() {
  const { month, print } = parseArgs(process.argv.slice(2));
  const data = collect(month);
  const auto = renderAuto(data);

  if (print) {
    process.stdout.write(`${auto}\n`);
    return;
  }

  const target = path.join(reportDir, `${month}.md`);
  let content;
  if (fs.existsSync(target)) {
    content = fs.readFileSync(target, "utf8");
    const start = content.indexOf(AUTO_BEGIN);
    const end = content.indexOf(AUTO_END);
    if (start === -1 || end === -1) {
      throw new Error(`${target} 缺少 ${AUTO_BEGIN} / ${AUTO_END} 标记，拒绝改写正文`);
    }
    content = content.slice(0, start) + auto + content.slice(end + AUTO_END.length);
    console.log(`已刷新数据附录：monthly-reports/${month}.md`);
  } else {
    const [year, mon] = month.split("-");
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    content = fs
      .readFileSync(templatePath, "utf8")
      .replaceAll("{{MONTH_TITLE}}", `${year} 年 ${Number(mon)} 月`)
      .replaceAll("{{BRANCH}}", branch)
      .replaceAll("{{GENERATED_AT}}", new Date().toISOString().slice(0, 10))
      .replaceAll("{{AUTO_BLOCK}}", auto);
    console.log(`已生成骨架：monthly-reports/${month}.md（正文待填写）`);
  }

  fs.writeFileSync(target, content);
  console.log(
    `  提交 ${data.commits.length} 次，发版提交 ${data.releases.length} 条，新增测试 ${data.newTests.length} 个`,
  );
}

try {
  main();
} catch (error) {
  console.error(`月报生成失败：${error.message}`);
  process.exitCode = 1;
}
