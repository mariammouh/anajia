# Anajia · 
**"The survivor"**: a mobile-first women's health companion, built as a hackathon prototype for the
Future Health Digital Innovation Challenge (fertility / population health / wellbeing).

Anajia helps women understand symptoms faster instead of living through years of trial and error:

1. **Log** symptoms in three taps (body map, symptom chips, 0–10 intensity).
2. **Insights**: a transparent, rule-based engine shows "patterns commonly associated with…",
   with the contributing symptoms, the points behind the score and sourced evidence statements.
3. **Community**: structured experience cards (what she tried, for how long, result, side effects).
4. **Doctor**: questions to ask, exams to discuss and a printable symptom timeline (Save as PDF).
5. **Safety**: red-flag rules open an urgent "seek care" screen.

Languages: French (default), Arabic (full RTL), English. Target: women in Morocco / MENA.

> **Anajia never diagnoses and never prescribes.** It is a prototype, not a medical device.
> All medical statements in it are **unverified** (see [What must be verified](#what-must-be-verified-before-any-real-use)).


---

## How to run

No backend, no build step, no dependencies.

**Option A: double-click.** Open `index.html` in a browser. Everything works offline
(the web fonts are optional; system fonts are used without a connection).

**Option B: local server** (needed if you want the app to read the JSON files live while you edit them):

```bash
cd Anajia
python -m http.server 8000
# then open http://localhost:8000
```

If the page stays on the loading screen with the Python server, reload it (a "Reload" link
appears after 9 seconds) or use Option A. On the development machine, antivirus web shields
(Norton 360, 360 Total Security) intermittently stalled localhost responses to Chrome; opening the
file directly is not affected.

### 60-second judge demo

1. First screen: tap **"Essayer avec un profil démo"** and pick a persona
   (or later: gear icon, then *Profils démo*).
   - 🌸 **Salma**, 22: painful periods and PMS
   - 🦋 **Imane**, 29: endometriosis-like pattern
   - 🌿 **Khadija**, 26: PCOS-like pattern
2. **Home**: mood check (the mascot reacts), cycle day, tip of the day.
3. **Insights**: the leading pattern card, its points, the cycle-timing clues, then open
   *"Sources, approches et détail"*. Tap *"Comment ça marche ?"* for the scoring explanation.
4. **Journal**: tap a zone on the body map, pick a symptom, save (confetti).
   To show the safety screen, open the 🚨 category, pick *Fièvre* and, under 💥, *Douleur pelvienne hors règles*, then save.
5. **Médecin**: questions, exams, timeline, then **Imprimer / PDF**.
6. **Communauté**: filters and "Ça m'a aidée aussi".
7. Switch language with **FR / ع / EN** in the top bar (Arabic flips the whole layout to RTL).
8. Gear icon: toggle **"Afficher le statut de vérification"** (dev mode) and **"Supprimer toutes mes données"**.

---

## Structure

```
Anajia/
├── index.html              App shell (top bar, view, tab bar, overlays)
├── styles.css              All styles: palette, components, RTL, print layout
├── app.js                  Logic: state, scoring engine, personas, views, modals, events
├── i18n.js                 Interface strings in fr / ar / en
├── data/
│   ├── knowledge.json      Knowledge base: symptoms, red flags, tips, conditions  ← edit this
│   ├── community.json      18 fictional experience cards (demo data)              ← edit this
│   └── data.bundle.js      GENERATED mirror of the two JSON files, for double-click mode
├── tools/
│   └── sync_data.py        Validates the JSON and regenerates data.bundle.js
└── tests/
    └── e2e.mjs             End-to-end check in headless Chrome (no dependencies)
```

**Why `data.bundle.js`?** Browsers block `fetch()` on `file://` pages, so a double-clicked
`index.html` cannot read JSON files. The JSON files remain the single source of truth:

| How the app is opened | Where data comes from |
|---|---|
| `http://localhost…` | `data/knowledge.json` and `data/community.json`, fetched live |
| double-click (`file://`) | `data/data.bundle.js` |

After editing either JSON file, run `python tools/sync_data.py` so both modes stay identical.
The script also validates the knowledge base (unknown symptom ids, missing translations,
weights outside 1–3, evidence without a `verified` field…).

**User data** lives only in `localStorage` under the key `anajia.v1` (profile, logs, moods,
"helped me too" marks, own community cards, doctor checklist, settings). Nothing is sent anywhere.
*Settings → Supprimer toutes mes données* removes the key.

---

## How the scoring works

The engine is in `app.js`, section 4 (`Engine`), and is also exposed in the browser console as
`Anajia.Engine`. It uses no machine learning: only the rules below, which the app shows to the
user in the "How it works" modal.

- Analysis window: the last **120 days** of logs (`meta.scoring.windowDays`).
- Each condition lists symptoms with a **weight from 1 to 3**. A logged symptom earns
  `weight × (0.5 + 0.5 × average intensity ÷ 10)`.
- **Bonus rules** add fixed points when cycle context fits:
  - `timing`: a share of the listed symptoms falls in a cycle phase (`menstrual`, `luteal`, `non_menstrual`)
  - `intensity`: average intensity of the listed symptoms is at least `minAvg`
  - `cycle_length`: average cycle length (from logged period starts) is at least `min` days
- `score = points earned ÷ points possible`. Levels: **strong ≥ 50%**, **moderate ≥ 25%**, **slight ≥ 10%**.
- **Red flags** are independent of the score and are checked on each saved entry.
  `level: "urgent"` opens the full-screen "seek care" screen; `level: "soon"` adds a
  "worth raising with a doctor soon" card in Insights.

The weights, bonus points and thresholds are **design choices made for this prototype**. They are
not clinically validated and have no measured sensitivity or specificity.

Demo persona results with the current knowledge base:

| Persona | Painful periods & PMS | Endometriosis | PCOS |
|---|---|---|---|
| Salma | **73% strong** | 17% slight | 8% |
| Imane | 34% moderate | **65% strong** | 3% |
| Khadija | 18% slight | 7% | **75% strong** |

---

## How to add a condition

Everything is data. No JavaScript change is needed.

1. **Add any missing symptoms** to `symptoms` in `data/knowledge.json`:

   ```json
   { "id": "hot_flashes", "emoji": "🥵", "category": "mood", "regions": ["general"],
     "label": { "fr": "Bouffées de chaleur", "ar": "هبّات ساخنة", "en": "Hot flashes" } }
   ```

   `category` must be one of `categories[].id`; `regions` must be ids from `regions`.
   Add `"binary": true` for yes/no signals without an intensity slider.

2. **Add the condition** to `conditions`:

   ```json
   {
     "id": "my_condition",
     "emoji": "🌼",
     "color": "#FFD166",
     "name":      { "fr": "…", "ar": "…", "en": "…" },
     "shortName": { "fr": "…", "ar": "…", "en": "…" },
     "about":     { "fr": "…", "ar": "…", "en": "…" },

     "symptoms": [
       { "id": "hot_flashes", "weight": 3 },
       { "id": "sleep_problems", "weight": 2 }
     ],

     "rules": [
       { "id": "my_rule", "type": "timing", "symptoms": ["hot_flashes"], "phase": "luteal",
         "minShare": 0.6, "minCount": 2, "points": 3,
         "label": { "fr": "…", "ar": "…", "en": "…" } }
     ],

     "redFlags": [
       { "id": "rf_my_flag", "level": "soon",
         "any": [ { "symptom": "hot_flashes", "min": 9 } ],
         "title":   { "fr": "…", "ar": "…", "en": "…" },
         "message": { "fr": "…", "ar": "…", "en": "…" } }
     ],

     "evidence": [
       { "id": "my_e1",
         "statement": { "fr": "…", "ar": "…", "en": "…" },
         "source": "NICE",
         "sourceDetail": "Exact title of the real document, with year",
         "level": "guideline",
         "verified": false }
     ],

     "doctorQuestions": [ { "fr": "…", "ar": "…", "en": "…" } ],
     "exams": [ { "name": { "fr": "…", "ar": "…", "en": "…" }, "why": { "fr": "…", "ar": "…", "en": "…" } } ],
     "lifestyle": [
       { "text": { "fr": "…", "ar": "…", "en": "…" }, "source": "NICE",
         "strength": "guideline_mentioned", "verified": false }
     ]
   }
   ```

   - `source` must be a key of `meta.sources`; `level` a key of `meta.evidenceLevels`.
   - Red-flag conditions: `all` (every item must match) and/or `any` (at least one). An item is
     either a symptom id, or `{ "symptom": id, "min": intensity }`.
   - `strength` is `guideline_mentioned` or `limited`.
   - Keep `"verified": false` until a qualified person has checked the statement against the source.

3. Run `python tools/sync_data.py`. Fix anything it reports.
4. Optional: add community cards for the new condition in `data/community.json`, and a demo
   persona in the `PERSONAS` array of `app.js` (section 5).
5. Run `node tests/e2e.mjs` and check the new card in Insights.

---

## What must be verified before any real use

The evidence statements were written from general knowledge of these organisations' publications.
**The original documents were not opened or checked while building this prototype.** No PMIDs,
page numbers or quotations are given, on purpose. Every item carries `"verified": false`, and the
developer toggle *Show verification status* displays that flag on each statement.

For each item: find the document (the organisation's site, or PubMed for guidelines published in
journals), confirm it exists under that title, confirm the statement matches its current wording,
then set `"verified": true`.

### Evidence statements (17)

| id | Claim to check | Source to locate |
|---|---|---|
| `dys_e1` | Primary dysmenorrhea is period pain without pelvic disease, linked to prostaglandins; starts just before/at onset, lasts 1–3 days | ACOG patient FAQ "Dysmenorrhea: Painful Periods" |
| `dys_e2` | No improvement after **3–6 months** of first-line treatment should prompt a search for secondary causes | ACOG Committee Opinion No. 760 (2018). Check number, year and the exact time frame |
| `dys_e3` | NSAIDs and hormonal options are first-line; local heat may help | NICE CKS "Dysmenorrhoea" |
| `dys_e4` | PMS symptoms occur before the period and resolve after onset; daily recording for at least 2 cycles | ACOG patient FAQ "Premenstrual Syndrome (PMS)" |
| `dys_e5` | PMDD is a severe form with marked emotional symptoms; care options exist | ACOG Clinical Practice Guideline No. 7 (2023). **Check the guideline number and year** |
| `endo_e1` | About 10% of reproductive-age women and girls, about 190 million | WHO fact sheet "Endometriosis" |
| `endo_e2` | Symptom list | WHO fact sheet "Endometriosis" |
| `endo_e3` | Suspect endometriosis with one or more of the listed signs | NICE NG73 (check the current, updated list) |
| `endo_e4` | Normal examination, ultrasound or MRI does not exclude endometriosis | NICE NG73 |
| `endo_e5` | Laparoscopy is no longer the mandatory diagnostic step; imaging first | ESHRE Guideline: Endometriosis (2022). Check the exact wording |
| `endo_e6` | Diagnostic delay is a recognised problem; a symptom diary helps | NICE NG73. "Several years" is deliberately unquantified: add a sourced figure or keep it vague |
| `pcos_e1` | Prevalence and "up to 70% undiagnosed" | WHO fact sheet "Polycystic ovary syndrome". **The prevalence range differs between versions of the fact sheet (6–13% vs 8–13%): align with the current one** |
| `pcos_e2` | Two of three criteria in adults, AMH as an alternative to ultrasound | 2023 International Evidence-based Guideline for PCOS (Monash-led, published with ESHRE and others). Confirm AMH applies to adults only |
| `pcos_e3` | Common signs | WHO fact sheet "Polycystic ovary syndrome" |
| `pcos_e4` | Higher metabolic and psychological risk; screening recommended | 2023 International PCOS Guideline |
| `pcos_e5` | Healthy lifestyle recommended for everyone with PCOS, whatever the weight | 2023 International PCOS Guideline |
| `pcos_e6` | A leading cause of anovulation and infertility, usually manageable | WHO fact sheet "Polycystic ovary syndrome" |

### Also unverified

- **Lifestyle approaches** (15 items): each carries a `source` and a `strength`
  (`guideline_mentioned` / `limited`). These attributions are the least certain part of the
  knowledge base, especially the non-medical approaches attributed to ESHRE for endometriosis and
  heat attributed to NICE. Check each one or remove the source label.
- **Exams to discuss** and **doctor questions**: written to be neutral ("to discuss"), but they
  need review by a gynaecologist.
- **Red-flag rules**: the five urgent rules follow the brief. Their wording and thresholds
  (for example "soon" at cramps ≥ 9/10) need clinical review. A sixth urgent rule was added for
  "very dark thoughts", because PMDD is in scope; it has no local helpline number.
- **Emergency numbers** on the urgent screen: 141 (SAMU) and 15 (Protection civile) for Morocco.
  Confirm them, and add numbers for other target countries.
- **Scoring weights and thresholds**: prototype design choices, not validated.
- **Tips of the day** (10): general wellbeing wording, unsourced.
- **Translations**: French, Arabic and English were all written by an AI assistant. The Arabic
  medical terminology in particular needs review by a native-speaking clinician
  (Modern Standard Arabic is used, not Darija).
- **Community cards**: all 18 are fictional and labelled "Demo data" in the app.

---

## Tests

```bash
node tests/e2e.mjs            # needs Node 22+, Python 3 and Chrome or Edge
```

The script starts a local server, drives the real app in headless Chrome at 360 px wide and exits
non-zero on any failure. It currently runs **91 checks**, all passing, covering:

- first run and onboarding (nickname, anonymous, language, cycle), persistence in `localStorage`
- mood check and mascot reaction
- logging in three taps, body-map filtering, intensity slider, same-day update
- the five required red-flag rules plus negative cases (fever alone, pregnancy alone…)
- the three personas end to end: expected pattern ranked first and "strong", timing rules matched,
  Insights / Doctor / Community / Log rendering, no horizontal overflow at 360 px
- "already diagnosed with" filter, verification toggle, "How it works", community filters,
  "helped me too", sharing a card, doctor checklist, print layout and PDF export
- French, Arabic (RTL) and English on all five tabs, with no missing strings
- reload with deep link, "Delete all my data", and double-click mode (`file://`)
- **no console errors or uncaught exceptions** during the whole run

Not covered: real phones, Safari and Firefox, screen readers, and the print dialog itself
(the print layout is checked through Chrome's PDF export).

---

## Known limitations

- Prototype: no accounts, no sync, no backup. Clearing browser data deletes everything.
- One log entry per day. Saving again on the same day updates it.
- Cycle phases are estimates from logged period start dates and an average cycle length.
- The engine ignores age, medical history, medication and examination findings.
- Community cards written by the user stay on the device; there is no moderation or sharing.
- Fonts (Nunito, Tajawal) load from Google Fonts when online; offline, system fonts are used.
