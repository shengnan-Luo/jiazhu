"""把 ECDICT 的 ecdict.csv 预处理成插件使用的精简词典。

用法:
    python tools/build_dict.py <ecdict.csv 路径> [输出目录，默认 extension/dict]

ECDICT: https://github.com/skywind3000/ECDICT (MIT License)

输出文件:
    core.json    常用词  {word: [level, gloss]}
    forms.json   变形 -> 原形  {form: lemma}
    rare.json    低频/专业词  {word: gloss}
    detail.json  卡片详情  {word: [phonetic, translation]}

level 含义:
    1 基础(中考/高考/最高频)  2 四级  3 六级  4 考研/雅思/托福  5 GRE/低频
    rare.json 里的词在插件里视为 level 6 (专业/罕见词)
"""

import csv
import json
import os
import re
import sys

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
    for w in common:
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


if __name__ == "__main__":
    main()
