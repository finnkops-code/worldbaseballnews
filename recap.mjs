// recap.mjs
// Doel: haal gisterse honkbaluitslagen van opgegeven Flashscore-competities en produceer een Markdown "Daily Recap".
// Benodigd: Node 18+, Playwright.
// Gebruik: 1) npm i -D playwright  2) npx playwright install chromium  3) node recap.mjs
// Uitvoer: ./out/recap-YYYY-MM-DD.md
// Let op: Houd je aan de Flashscore-gebruiksvoorwaarden. Pas de COMPETITIONS aan met de exacte resultatenpagina's van actieve competities.

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// ======= CONFIG =======
// Voeg hier resultatenpagina's toe. Voorbeeld (Cuba Serie Nacional):
// 'https://www.flashscore.com/baseball/cuba/serie-nacional/results/'
const COMPETITIONS = [
  // Cuba – Serie Nacional
  'https://www.flashscore.com/baseball/cuba/serie-nacional/results/',
  // Dominican Republic – LIDOM
  'https://www.flashscore.com/baseball/dominican-republic/lidom/results/',
  // Venezuela – LVBP
  'https://www.flashscore.com/baseball/venezuela/lvbp/results/',
  // Mexico – LMP
  'https://www.flashscore.com/baseball/mexico/lmp/results/',
  // Puerto Rico – LBPRC
  'https://www.flashscore.com/baseball/puerto-rico/lbprc/results/',
  // Colombia – LPB
  'https://www.flashscore.com/baseball/colombia/lpb/results/',
  // Australia – ABL
  'https://www.flashscore.ph/en/baseball/australia/abl/results/',
];

const TIMEZONE = 'Europe/Amsterdam'; // Pas aan indien nodig per jouw regio (beïnvloedt "gisteren").
// ===== END CONFIG =====

function formatDateYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getYesterday(tz) {
  const now = new Date();
  // Converteer naar doel-tijdzone via Intl hack
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(now);
  const mm = Number(parts.find(p => p.type === 'month').value);
  const dd = Number(parts.find(p => p.type === 'day').value);
  const yy = Number(parts.find(p => p.type === 'year').value);
  const localNow = new Date(Date.UTC(yy, mm - 1, dd));
  localNow.setUTCDate(localNow.getUTCDate() - 1);
  return new Date(localNow);
}

const YESTERDAY = getYesterday(TIMEZONE);
const DATE_LABEL = formatDateYMD(YESTERDAY);

async function scrapeCompetition(page, url) {
  const results = [];
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Sta cookies/consent toe indien pop-up verschijnt.
  try {
    await page.locator('button:has-text("Accept all")').click({ timeout: 2000 });
  } catch {}

  // Wacht tot de lijst met events zichtbaar is
  await page.waitForSelector('.sportName.baseball, .sportName', { timeout: 15000 });

  // Flashscore structureert events per datum. We selecteren alle "finished" wedstrijden en filteren op de juiste datum.
  // Deze selectors zijn gebaseerd op veel voorkomende Flashscore-classnames; ze kunnen wijzigen.
  const rows = page.locator('.event__match.event__match--twoLine, .event__match');
  const count = await rows.count();

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);

    // status en datum ophalen
    const status = (await row.getAttribute('class')) || '';
    const isFinished = status.includes('event__match--finished');
    if (!isFinished) continue;

    // Datum staat meestal in de dichtstbijzijnde .event__time of bovenliggende dagheader.
    // We proberen beide strategieën.
    let dateText = await row.locator('.event__time').first().textContent().catch(() => null);
    dateText = dateText ? dateText.trim() : '';

    // Zoek naar dagheader boven dit element
    let headerDate = '';
    try {
      const header = await row.locator('xpath=preceding::div[contains(@class, "event__day")]').last();
      headerDate = (await header.textContent())?.trim() || '';
    } catch {}

    // Normaliseer datum; Flashscore gebruikt vaak "dd.mm." of gedrukte dagnaam. We matchen YESTERDAY.
    const isYesterday = () => {
      const d = YESTERDAY;
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      // Mogelijke formats in UI
      const tokens = [
        `${dd}.${mm}.`, // 09.11.
        `${dd}.${mm}`,  // 09.11
        `${dd}-${mm}`,  // 09-11
      ];
      const hay = `${dateText} ${headerDate}`;
      return tokens.some(t => hay.includes(t));
    };

    if (!isYesterday()) continue;

    const home = (await row.locator('.event__participant--home').textContent().catch(() => ''))?.trim();
    const away = (await row.locator('.event__participant--away').textContent().catch(() => ''))?.trim();
    const sh = (await row.locator('.event__score--home').textContent().catch(() => ''))?.trim();
    const sa = (await row.locator('.event__score--away').textContent().catch(() => ''))?.trim();
    if (!home || !away || !sh || !sa) continue;

    const homeScore = Number(sh);
    const awayScore = Number(sa);
    let winnerHome = homeScore > awayScore;

    results.push({ home, away, homeScore, awayScore, winnerHome });
  }

  // Competitienaam uit header halen
  let compName = 'Unknown competition';
  try {
    compName = (await page.locator('h1').first().textContent()).trim();
  } catch {}

  return { competition: compName, matches: results };
}

function toRecapMD(buckets) {
  // Sorteer competities alfabetisch op naam
  const sorted = buckets
    .filter(b => b.matches.length > 0)
    .sort((a, b) => a.competition.localeCompare(b.competition));

  let md = `Daily Recap – ${DATE_LABEL}\n\n`;
  for (const b of sorted) {
    md += `### ${b.competition}\n`;
    for (const m of b.matches) {
      const line = m.winnerHome
        ? `**${m.home} (W)** – ${m.away} (L) Final score: ${m.homeScore}–${m.awayScore}`
        : `${m.home} (L) – **${m.away} (W)** Final score: ${m.homeScore}–${m.awayScore}`;
      md += line + '\n';
    }
    md += '\n';
  }
  return md.trim() + '\n';
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const buckets = [];
  for (const url of COMPETITIONS) {
    try {
      const bucket = await scrapeCompetition(page, url);
      buckets.push(bucket);
    } catch (e) {
      console.error('Fout bij competitie', url, e.message);
    }
  }

  await browser.close();

  const md = toRecapMD(buckets);
  await fs.mkdir(path.join('out'), { recursive: true });
  const file = path.join('out', `recap-${DATE_LABEL}.md`);
  await fs.writeFile(file, md, 'utf8');
  console.log(`✅ Recap opgeslagen: ${file}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

/* === Optionele automatisering via GitHub Actions ===
Plaats de onderstaande YAML als **.github/workflows/recap.yml** in je repo. Dit draait elke dag om 06:00 UTC en pusht de MD-uitvoer naar de repo.
*/

// ==== BEGIN: .github/workflows/recap.yml ====
// (Kopieer alles onder deze regel naar een apart bestand: .github/workflows/recap.yml)
/*
name: Daily Recap
on:
  schedule:
    - cron: '0 6 * * *'   # 06:00 UTC (07:00 NL wintertijd)
  workflow_dispatch:
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install Playwright
        run: |
          npm i -D playwright
          npx playwright install --with-deps chromium
      - name: Run scraper
        run: node recap.mjs
      - name: Commit results
        run: |
          git config user.name 'github-actions'
          git config user.email 'actions@users.noreply.github.com'
          git add out/*.md || true
          git commit -m "Daily Recap $(date -u +%F)" || echo 'niets te committen'
          git push
*/
// ==== EINDE: .github/workflows/recap.yml ====

// ==== BEGIN: .gitignore (advies) ====
/*
node_modules/
out/*.html
playwright-report/
test-results/
*/
// ==== EINDE: .gitignore ====

// ==== BEGIN: out/.gitkeep ====
/*
(Leeg bestand om de map /out/ te behouden in Git.)
*/
// ==== EINDE: out/.gitkeep ====
