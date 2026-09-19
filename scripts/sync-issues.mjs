#!/usr/bin/env node
/**
 * 以 GitHub Issues 为唯一写入入口，全量重建 notes/ 目录与 README 索引。
 *
 * 只收录满足全部条件的 issue：
 *   - 由仓库所有者创建（防止任何人通过开 issue 往仓库写文件）
 *   - 带有 PUBLISH_LABEL 标签
 *   - 状态为 open
 *
 * 全量重建而非增量更新，是为了让改标题 / 去标签 / 关闭 / 删除 issue
 * 都自动反映到文件上，不必为每种 webhook 事件单独写逻辑。
 *
 * 环境变量：
 *   REPO           必填，形如 owner/name
 *   GH_TOKEN       必填，Actions 里用 secrets.GITHUB_TOKEN
 *   PUBLISH_LABEL  可选，默认 note
 *   OUT_DIR        可选，默认 notes
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = requireEnv('REPO');
const TOKEN = requireEnv('GH_TOKEN');
const PUBLISH_LABEL = process.env.PUBLISH_LABEL || 'note';
const OUT_DIR = process.env.OUT_DIR || 'notes';
const README = 'README.md';
const INDEX_START = '<!-- notes:start -->';
const INDEX_END = '<!-- notes:end -->';

const [OWNER] = REPO.split('/');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

/** 调用 GitHub REST API，自动翻页。 */
async function fetchAllIssues() {
  const issues = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/repos/${REPO}/issues`);
    url.searchParams.set('labels', PUBLISH_LABEL);
    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${TOKEN}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'sync-issues-script',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }

    const batch = await response.json();
    if (batch.length === 0) break;
    issues.push(...batch);
    if (batch.length < 100) break;
  }
  return issues;
}

/** /issues 端点会把 PR 一起返回，且只认仓库所有者自己写的条目。 */
function isPublishable(issue) {
  return !issue.pull_request && issue.user?.login === OWNER;
}

/**
 * 生成文件名。number 前缀保证唯一且稳定，slug 只为可读性。
 * 保留中日韩字符，其余非字母数字折叠成连字符。
 */
function toFileName(issue) {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug ? `${issue.number}-${slug}.md` : `${issue.number}.md`;
}

/**
 * 用 JSON.stringify 产出 YAML 双引号标量：引号、冒号、反斜杠、换行都会被正确转义，
 * 避免标题里出现 `: ` 或 `"` 时把 frontmatter 撑破。
 */
const yamlString = (value) => JSON.stringify(String(value));

function toMarkdown(issue) {
  const tags = issue.labels
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((name) => name !== PUBLISH_LABEL);

  const frontmatter = [
    '---',
    `title: ${yamlString(issue.title)}`,
    `created: ${issue.created_at.slice(0, 10)}`,
    `updated: ${issue.updated_at.slice(0, 10)}`,
    `tags: [${tags.map(yamlString).join(', ')}]`,
    `issue: ${issue.number}`,
    `source: ${yamlString(issue.html_url)}`,
    '---',
  ].join('\n');

  // 正文统一成 LF，避免 CRLF 让 git 每次都判定有改动。
  const body = (issue.body || '').replace(/\r\n/g, '\n').trim();

  return `${frontmatter}\n\n# ${issue.title}\n\n${body}\n`;
}

/**
 * 按标签分组的索引。
 * linkPrefix 决定链接的相对基准：README 在仓库根，需要 `notes/` 前缀；
 * 站点首页本身就在 OUT_DIR 里，前缀为空。
 */
function buildIndex(issues, linkPrefix) {
  if (issues.length === 0) return '_还没有笔记。开一个 Issue 并打上 `note` 标签即可。_';

  const byTag = new Map();
  for (const issue of issues) {
    const tags = issue.labels
      .map((label) => (typeof label === 'string' ? label : label.name))
      .filter((name) => name !== PUBLISH_LABEL);
    for (const tag of tags.length > 0 ? tags : ['未分类']) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(issue);
    }
  }

  const lines = [`共 ${issues.length} 条笔记。`, ''];
  for (const tag of [...byTag.keys()].sort((a, b) => a.localeCompare(b, 'zh'))) {
    lines.push(`### ${tag}`, '');
    const entries = byTag
      .get(tag)
      .slice()
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    for (const issue of entries) {
      const file = `${linkPrefix}${toFileName(issue)}`;
      lines.push(
        `- [${issue.title}](${encodeURI(file)}) ` +
        `· ${issue.updated_at.slice(0, 10)} ` +
        `· [#${issue.number}](${issue.html_url})`,
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

async function updateReadme(index) {
  let content;
  try {
    content = await readFile(README, 'utf8');
  } catch {
    content = `# 笔记\n\n${INDEX_START}\n${INDEX_END}\n`;
  }

  if (!content.includes(INDEX_START) || !content.includes(INDEX_END)) {
    throw new Error(`${README} 缺少 ${INDEX_START} / ${INDEX_END} 标记，索引无处可写`);
  }

  const before = content.slice(0, content.indexOf(INDEX_START) + INDEX_START.length);
  const after = content.slice(content.indexOf(INDEX_END));
  await writeFile(README, `${before}\n\n${index}\n\n${after}`, 'utf8');
}

/**
 * 站点首页。MkDocs 用 OUT_DIR 当 docs_dir，必须有 index.md 才能构建，
 * 所以哪怕一条笔记都没有也要生成它。
 */
async function writeSiteIndex(index) {
  const content = [
    '---',
    'title: 笔记',
    '---',
    '',
    '# 笔记',
    '',
    '个人知识库。所有内容都是从 GitHub Issues 自动同步生成的。',
    '',
    '## 索引',
    '',
    index,
    '',
  ].join('\n');
  await writeFile(path.join(OUT_DIR, 'index.md'), content, 'utf8');
}

async function main() {
  const issues = (await fetchAllIssues()).filter(isPublishable);

  // 先清空再写，删除 / 去标签 / 关闭的 issue 对应的文件就自然消失了。
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  for (const issue of issues) {
    await writeFile(path.join(OUT_DIR, toFileName(issue)), toMarkdown(issue), 'utf8');
  }

  await writeSiteIndex(buildIndex(issues, ''));
  await updateReadme(buildIndex(issues, `${OUT_DIR}/`));
  console.log(`已同步 ${issues.length} 条笔记到 ${OUT_DIR}/`);
}

await main();
