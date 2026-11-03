"""把 ECDICT 的 ecdict.csv 预处理成插件使用的精简词典。

用法:
    python tools/build_dict.py <ecdict.csv 路径> [输出目录，默认 extension/dict]

ECDICT: https://github.com/skywind3000/ECDICT (MIT License)

输出文件:
    core.json    常用词  {word: [level, gloss]}
    forms.json   变形 -> 原形  {form: lemma}
    rare.json    低频/专业词  {word: gloss}
    detail.json  卡片详情  {word: [phonetic, translation]}
    zh.json      中文网页复习用  {"terms": {中文词: [[英文, 词表], ...]}, "tiers": {英文: 词表}}

level 含义:
    1 基础(中考/高考/最高频)  2 四级  3 六级  4 考研/雅思/托福  5 GRE/低频
    rare.json 里的词在插件里视为 level 6 (专业/罕见词)

zh.json 的词表: 1 四级  2 六级(四级以外的)  3 雅思/托福(四六级以外的)
"""

import csv
import json
import math
import os
import re
import sys
from collections import defaultdict

TAG_LEVEL = {"zk": 1, "gk": 1, "cet4": 2, "cet6": 3, "ky": 4, "ielts": 4, "toefl": 4, "gre": 5}
WORD_RE = re.compile(r"[a-z]{2,}")
POS_RE = re.compile(
    r"^(?:(?:n|v|vt|vi|a|adj|ad|adv|prep|conj|pron|int|interj|num|art|abbr|aux|pl|det|modal|suf|pref|phr)\.\s*)+",
    re.I,
)
BRACKET_RE = re.compile(r"\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）|<[^>]*>|〈[^〉]*〉")
SPLIT_RE = re.compile(r"[；;,，、/]")
INFLECTION_HINT = re.compile(r"的(复数|过去式|过去分词|现在分词|第三人称|比较级|最高级)")
NAME_HINT = re.compile(r"人名|地名|姓氏|男子名|女子名|男名|女名")


def lines_of(translation):
    return [s.strip() for s in translation.replace("\\r", "").split("\\n") if s.strip()]


SCI_DOMAIN_RE = re.compile(r"^\[(化|物|医|生|数|电|机|地|计|天|植|动|环|材|药|农)\]")


def first_sense(line):
    text = POS_RE.sub("", line)
    text = BRACKET_RE.sub("", text)
    text = POS_RE.sub("", text.strip())
    for part in SPLIT_RE.split(text):
        part = part.strip(" .。:：…~～\"'“”")
        if part and re.search(r"[一-鿿]", part):
            return part
    return ""


def short_gloss(translation, max_len=8):
    lines = lines_of(translation)
    # 优先用普通义项，其次学科义项，最后 [网络]
    general = [l for l in lines if not l.startswith("[")]
    ordered = general + [l for l in lines if l.startswith("[") and not l.startswith("[网络]")] + [
        l for l in lines if l.startswith("[网络]")
    ]
    gloss = next((s for s in map(first_sense, ordered) if s), "")
    if len(gloss) > max_len:
        return gloss[:max_len] + "…"
    # 词典的普通义项偏旧（mechanism 机械、prediction 预言），学科义项更接近论文里的用法，短的话一并显示
    if general and gloss:
        for line in lines:
            if SCI_DOMAIN_RE.match(line):
                sci = first_sense(line)
                if sci and sci not in gloss and gloss not in sci and len(gloss) + len(sci) + 1 <= max_len:
                    gloss = f"{gloss}/{sci}"
                break
    return gloss


def level_of(row):
    tags = [t for t in row["tag"].split() if t in TAG_LEVEL]
    if tags:
        return min(TAG_LEVEL[t] for t in tags)
    ranks = [int(x) for x in (row["frq"] or "0", row["bnc"] or "0") if int(x) > 0]
    r = min(ranks) if ranks else 10**9
    if r <= 3000:
        return 1
    if r <= 6000:
        return 2
    if r <= 10000:
        return 3
    if r <= 20000:
        return 4
    return 5


def is_common(row):
    if row["tag"].strip() or row["collins"] or row["oxford"]:
        return True
    for x in (row["frq"], row["bnc"]):
        if x and 0 < int(x) <= 60000:
            return True
    return False


def parse_exchange(ex):
    out = {}
    for item in ex.split("/"):
        if ":" in item:
            k, v = item.split(":", 1)
            out[k] = v
    return out


def freq_rank(row):
    ranks = [int(x) for x in (row["frq"] or "0", row["bnc"] or "0") if int(x) > 0]
    return min(ranks) if ranks else 10**6


# ---------- 中文 -> 英文（在中文网页上复习单词） ----------

HAN_TERM_RE = re.compile(r"^[一-鿿]{2,6}$")
POS_HEAD_RE = re.compile(r"^([a-z]+)\.", re.I)
# 虚词和太泛的词，反查出来的英文多半不对
ZH_STOP = set(
    """可以 可能 通过 根据 比较 一些 一个 这个 那个 我们 他们 你们 已经 没有 不是 就是 还是 只是 但是 因为 所以 如果
    虽然 而且 或者 以及 其中 对于 关于 由于 作为 成为 具有 包括 东西 时候 现在 自己 什么 怎么 这样 那么 然后 同时 不过
    当然 其实 甚至 也许 大概 所有 每个 任何 其他 另外 之后 之前 以后 以前 出来 起来 下来 知道 觉得 看到 得到 发生 存在
    需要 应该 能够 一样 一起 一直 一定 地方 事情""".split()
)


def zh_tier(tags):
    """中考词太基础，不拿来复习"""
    if "zk" in tags:
        return 0
    if "cet4" in tags:
        return 1
    if "cet6" in tags:
        return 2
    if "ielts" in tags or "toefl" in tags:
        return 3
    return 0


def zh_terms(translation):
    """普通义项里的中文词 -> (罚分, 是否去掉了“的/地”)。
    罚分：在这一行里越靠前越小；每多一行（换一种词性）+0.5，main 的“a. 主要的”在第二行也算主要义项"""
    out = {}
    general = [l for l in lines_of(translation) if not l.startswith("[")]
    for n, line in enumerate(general):
        m = POS_HEAD_RE.match(line)
        suffix = {"a": "的", "adj": "的", "ad": "地", "adv": "地"}.get(m.group(1).lower() if m else "")
        text = POS_RE.sub("", BRACKET_RE.sub("", POS_RE.sub("", line)).strip())
        for i, part in enumerate(SPLIT_RE.split(text)):
            part = part.strip(" .。:：~～\"'“”")
            pen = n / 2 + i
            # 重要的 -> 重要。网页上“分析的效率”里的“的”多半是助词，所以不收“X的”本身。
            # 副词排后：特定 应该是 specific，而不是 specifically（特定地）
            stripped = bool(suffix and part.endswith(suffix) and len(part) >= 3)
            if stripped:
                part = part[:-1]
                pen += suffix == "地"
            if HAN_TERM_RE.match(part) and pen < out.get(part, (99,))[0]:
                out[part] = (pen, stripped)
    return out


def build_zh(rows, words):
    """英汉词典反查：只用中文词最贴切的前两个英文（义项靠前、词频高），其中在三个词表里的才保留。
    最贴切的是基础词时（模型 -> model），宁可不标，也不退而求其次标个不相干的词表词（mold）"""
    cands = defaultdict(list)
    tiers = {}
    for w in words:
        r = rows[w]
        tier = zh_tier(r["tag"].split())
        freq = freq_rank(r)
        if tier:
            tiers[w] = tier
        for term, (pen, stripped) in zh_terms(r["translation"]).items():
            if pen <= 4 and term not in ZH_STOP:
                # 太生僻的词表词只参与排名，不拿来标注
                cands[term].append((pen + math.log10(freq) / 2, pen, stripped, freq, w, tier if freq <= 20000 else 0))
    terms = {}
    for term, c in cands.items():
        # 中文词既能当名词又能当形容词时（空间 / 空间的），看哪种用法对应的英文更常用：
        # space 比 spatial 常用，空间 就不标 spatial；important 比 importance 常用，重要 就不标 importance
        best = {k: min((x[3] for x in c if x[2] == k), default=10**9) for k in (False, True)}
        kind = best[True] < best[False]
        c = sorted(x for x in c if x[2] == kind and x[1] <= 1)
        if not c:
            continue
        # 排第二的要和第一差不多好，也不能比第一生僻太多（主要 -> main，不能退到 primal）
        limit = min(c[0][0] + 0.3, 2.6)
        rarest = c[0][3] * 3
        keep = [[w, t] for score, _, _, freq, w, t in c[:2] if t and score <= limit and freq <= rarest]
        if keep:
            terms[term] = keep
    return {"terms": terms, "tiers": tiers}


def main():
    src = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "extension", "dict")
    os.makedirs(out_dir, exist_ok=True)

    rows = {}
    with open(src, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            w = row["word"]
            if WORD_RE.fullmatch(w) and row["translation"].strip():
                rows[w] = row

    common = {w for w, r in rows.items() if is_common(r)}

    # 常用词的各种变形 -> 原形
    inflected = {}
    for w in sorted(common):
        ex = parse_exchange(rows[w]["exchange"])
        for k in ("p", "d", "i", "3", "s", "r", "t"):
            for form in ex.get(k, "").split(","):
                form = form.strip().lower()
                if WORD_RE.fullmatch(form) and form != w:
                    inflected.setdefault(form, w)

    core, detail, forms, rare = {}, {}, {}, {}
    # 1) 常用词。变形词（was/studies/phenomena）只要原形不比它难，就归到原形
    for w in sorted(common):
        r = rows[w]
        ex = parse_exchange(r["exchange"])
        lemma = ex.get("0") or inflected.get(w)
        if lemma and lemma != w and lemma in common and level_of(rows[lemma]) <= level_of(r):
            forms[w] = lemma
            continue
        if not r["tag"].strip():
            if INFLECTION_HINT.search(r["translation"]) or NAME_HINT.search(r["translation"]):
                continue
            if r["translation"].startswith("abbr.") and not r["collins"] and not r["oxford"]:
                continue
        g = short_gloss(r["translation"])
        if not g:
            continue
        core[w] = [level_of(r), g]
        detail[w] = [r["phonetic"], "\n".join(lines_of(r["translation"]))[:300]]

    # 2) 其余变形
    for form, w in inflected.items():
        if w in core and form not in core and form not in forms:
            forms[form] = w

    # 3) 低频/专业词
    for w, r in rows.items():
        if w in core or w in forms:
            continue
        tr = r["translation"]
        ex = parse_exchange(r["exchange"])
        lemma = ex.get("0")
        if lemma and lemma != w and (lemma in core or lemma in rows):
            forms[w] = lemma
            continue
        if INFLECTION_HINT.search(tr) or NAME_HINT.search(tr) or tr.startswith("abbr."):
            continue
        g = short_gloss(tr)
        if g:
            rare[w] = g
    # 指向低频词但原形没被收录的变形，丢掉
    forms = {k: v for k, v in forms.items() if v in core or v in rare}

    def dump(name, obj):
        path = os.path.join(out_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        print(f"{name}: {len(obj)} 条, {os.path.getsize(path) / 1e6:.1f} MB")

    dump("core.json", core)
    dump("forms.json", forms)
    dump("rare.json", rare)
    dump("detail.json", detail)
    dump("zh.json", build_zh(rows, core))


if __name__ == "__main__":
    main()
