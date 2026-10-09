// Whether a goal is work I will see or use (ADR-064 §4): a UI, a site, an
// app, an instrument. Then the interview asks for an experience section and
// the plan's acceptance criteria include experience criteria. A backend
// job, a script, a migration, server work: none.

const UI_WORDS =
  /\b(ui|ux|frontend|front-end|interface|web ?app|webapp|website|web site|web page|landing page|page|pages|screen|screens|app|apps|mobile|phone|tablet|ipad|iphone|android|desktop app|dashboard|layout|design|designs|mockup|button|buttons|knob|knobs|slider|sliders|form|forms|menu|modal|dialog|theme|dark mode|css|html|react|vue|svelte|tailwind|game|player|editor|keyboard|instrument|synth|synthesizer|piano|logo|brand)\b/i;

/** Words that say the work has no screen of its own, whatever else it names. */
const BACKEND_ONLY =
  /\b(cli|command[- ]line|api endpoint|endpoint|rest api|graphql api|cron|migration|database schema|backend only|no ui|headless|daemon|server config|nginx|systemd|docker compose|script)\b/i;

/** The goal names something I will see or use: a UI, a site, an app. */
export function hasUi(goal: string): boolean {
  const text = goal.slice(0, 8000);
  if (!UI_WORDS.test(text)) return false;
  // "the API's page in the docs" is still a backend: UI words that only sit beside backend ones.
  if (BACKEND_ONLY.test(text)) {
    const strong =
      /\b(ui|ux|frontend|front-end|web ?app|webapp|website|screen|screens|mobile|phone|tablet|dashboard|layout|design|knobs?|sliders?|instrument|logo)\b/i;
    return strong.test(text);
  }
  return true;
}
