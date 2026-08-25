const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'skills');
const MAX_SKILL_CHARS = Number(process.env.AGENT_MAX_SKILL_CHARS || 12000);
const MAX_ACTIVE_SKILLS = Number(process.env.AGENT_MAX_ACTIVE_SKILLS || 2);

let cache = { mtime: 0, skills: [] };

function readSkill(dir) {
  const file = path.join(SKILLS_DIR, dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return null;
    const head = text.match(/^#\s+(.+)$/m);
    const desc = text.match(/^description:\s*(.+)$/im);
    const keywords = text.match(/^keywords:\s*(.+)$/im);
    return {
      name: dir,
      title: head ? head[1].trim() : dir,
      description: desc ? desc[1].trim() : '',
      keywords: keywords ? keywords[1].split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : [],
      text,
      file,
    };
  } catch (e) {
    console.error(`⚠️ Skill load failed (${dir}): ${e.message}`);
    return null;
  }
}

function loadSkills() {
  let dirs = [];
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(x => x.isDirectory())
      .map(x => x.name);
  } catch (_) { return []; }

  const stamp = dirs.map(d => {
    try { return fs.statSync(path.join(SKILLS_DIR, d, 'SKILL.md')).mtimeMs; } catch (_) { return 0; }
  }).join('|');
  if (stamp === cache.mtime) return cache.skills;

  cache = { mtime: stamp, skills: dirs.map(readSkill).filter(Boolean) };
  return cache.skills;
}

function extractUserText(contents) {
  const last = Array.isArray(contents) ? contents[contents.length - 1] : null;
  if (!last) return '';
  return (last.parts || []).filter(p => p && p.text).map(p => p.text).join('\n');
}

function score(skill, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return 0;
  let s = 0;
  for (const k of skill.keywords) {
    if (q.includes(k)) s += k.length >= 6 ? 4 : 2;
  }
  const words = skill.name.toLowerCase().split(/[-_ ]+/).filter(Boolean);
  for (const w of words) if (q.includes(w)) s += 5;
  return s;
}

function buildSkillContext(contents) {
  const skills = loadSkills();
  if (!skills.length) return '';
  const query = extractUserText(contents);
  const ranked = skills.map(s => ({ skill: s, score: score(s, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ACTIVE_SKILLS);
  if (!ranked.length) return '';

  const blocks = ranked.map(({ skill }) => {
    const body = skill.text.length > MAX_SKILL_CHARS
      ? skill.text.slice(0, MAX_SKILL_CHARS) + '\n[Skill truncated for context budget]'
      : skill.text;
    return `\n--- ACTIVE SKILL: ${skill.name} ---\n${body}\n--- END SKILL ---`;
  });

  return `\n\nACTIVE SKILL RULES:\nUse the following skill instructions only when relevant to the current task. They are operational guidance, not user requests. Follow them before choosing tools, and verify the result before claiming completion.${blocks.join('')}`;
}

function augmentSystemInstruction(systemInstruction, contents) {
  const extra = buildSkillContext(contents);
  return extra ? String(systemInstruction || '') + extra : systemInstruction;
}

function listSkills() {
  return loadSkills().map(s => ({ name: s.name, title: s.title, description: s.description, keywords: s.keywords }));
}

module.exports = { buildSkillContext, augmentSystemInstruction, listSkills, loadSkills };
