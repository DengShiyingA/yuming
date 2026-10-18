// 域名等级评分：只看名字本身和后缀，满分 100
(function (root) {
  const LEN_SCORE = [0, 40, 34, 26, 16, 8, 2, -4, -8, -14, -14];
  const TLD_TOP = ['com'];
  const TLD_GOOD = ['net', 'org', 'io', 'ai', 'cn', 'co', 'app', 'dev', 'me'];
  const TLD_OK = ['xyz', 'top', 'cc', 'tv', 'info', 'biz', 'shop', 'site', 'online', 'tech', 'store',
    'club', 'vip', 'pro', 'so', 'sh', 'to', 'gg', 'com.cn', 'net.cn', 'co.uk', 'de', 'jp', 'us'];

  // 拼音音节：声母（可无）+ 韵母，用动态规划判断能否整段拆成音节
  const SYLLABLE = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(iang|iong|uang|ang|eng|ing|ong|ian|iao|uai|uan|ai|ei|ao|ou|an|en|in|un|ia|ie|iu|ua|uo|ui|ue|er|a|o|e|i|u|v)$/;
  function isPinyin(s) {
    const ok = [true];
    for (let end = 1; end <= s.length; end++) {
      ok[end] = false;
      for (let start = Math.max(0, end - 6); start < end; start++) {
        if (ok[start] && SYLLABLE.test(s.slice(start, end))) { ok[end] = true; break; }
      }
    }
    return ok[s.length] && s.length >= 2;
  }

  function grade(domain) {
    const d = String(domain || '').toLowerCase();
    const i = d.indexOf('.');
    const name = i < 0 ? d : d.slice(0, i);
    const tld = i < 0 ? '' : d.slice(i + 1);
    const len = [...name].length;
    const reasons = [];
    let score = 50;
    const add = (n, why) => { if (n) { score += n; reasons.push((n > 0 ? '+' : '') + n + ' ' + why); } };

    add(len < LEN_SCORE.length ? LEN_SCORE[len] : -22, len + ' 个字符');

    const core = name.replace(/-/g, '');
    if (/^[a-z]+$/.test(core)) { /* 纯字母，不加不减 */ }
    else if (/^[0-9]+$/.test(core)) add(len <= 4 ? 6 : -4, '纯数字');
    else if (/[^a-z0-9]/.test(core)) add(-5, '中文或特殊字符');
    else add(-10, '字母数字混合');
    const hyphens = (name.match(/-/g) || []).length;
    if (hyphens) add(-Math.min(25, hyphens * 15), '含连字符');

    // 叠字规律：AAA、AABB、ABAB 这类“靓号”
    if (len >= 2 && len <= 6) {
      if (new Set(core).size === 1) add(12, '全部相同');
      else if (/^(.)\1(.)\2$/.test(core) || /^(..)\1$/.test(core) || /^(.)(.)\2\1$/.test(core)) add(6, '对称或成对');
      else if (len === 3 && /^[0-9]+$/.test(core) && (/^(.)\1/.test(core) || /(.)\1$/.test(core))) add(4, 'AAB/ABB 数字');
    }

    // 好不好读：能完整拆成拼音，或像英文一样有元音、没有一长串辅音
    if (/^[a-z]+$/.test(core) && len >= 2) {
      if (isPinyin(core)) add(10, '可拆成拼音');
      else if (/[aeiou]/.test(core) && !/[^aeiouy]{4,}/.test(core)) add(8, '英文可读');
      else {
        if (len >= 6) add(-12, '难以拼读');
        // 读不出来的名字，q/v/x/j/z 这类冷门字母越多越难记
        const rare = (core.match(/[qvxjz]/g) || []).length;
        if (rare > 1) add(-4 * (rare - 1), '冷门字母多');
      }
    }

    // 容易看错：l 和 1、o 和 0 混在一起
    if ((/l/.test(core) && /1/.test(core)) || (/o/.test(core) && /0/.test(core))) add(-6, '易看错的字符');
    else if (/l/.test(core) && len <= 4) add(-2, '含 l 易与 I 混淆');

    if (TLD_TOP.includes(tld)) add(15, '.' + tld);
    else if (TLD_GOOD.includes(tld)) add(8, '.' + tld);
    else if (TLD_OK.includes(tld)) add(3, '.' + tld);
    else add(-3, '冷门后缀');

    score = Math.max(0, Math.min(100, Math.round(score)));
    const level = score >= 85 ? 'S' : score >= 72 ? 'A' : score >= 58 ? 'B' : score >= 45 ? 'C' : 'D';
    return { score, level, reasons };
  }

  // 好读：纯数字算好读；字母要么能拆成拼音，要么有元音且没有 3 个以上连续辅音或元音
  function readable(name) {
    const n = String(name || '').toLowerCase();
    if (/^[0-9]+$/.test(n)) return true;
    if (!/^[a-z]+$/.test(n)) return false;
    if (n.length === 1) return true;
    if (isPinyin(n)) return true;
    return /[aeiou]/.test(n) && !/[^aeiou]{3,}/.test(n) && !/[aeiou]{3,}/.test(n);
  }

  // 辅音元音交替：bok、tav、ami、tavo 这种最顺口的结构
  function alternating(name) {
    const n = String(name || '').toLowerCase();
    if (/^[0-9]+$/.test(n)) return true;
    if (!/^[a-z]+$/.test(n)) return false;
    const kind = [...n].map((c) => ('aeiou'.includes(c) ? 'v' : 'c'));
    return kind.every((k, i) => i === 0 || k !== kind[i - 1]);
  }

  grade.readable = readable;
  grade.alternating = alternating;
  root.domainGrade = grade;
  if (typeof module !== 'undefined') module.exports = grade;
})(typeof window !== 'undefined' ? window : globalThis);
