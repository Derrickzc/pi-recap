# pi-recap

Small [pi](https://pi.dev) extension that updates the terminal tab title and shows an italic recap above the editor after each interaction.

By default, it uses `openai/gpt-5-nano` for the title and writes the recap in Simplified Chinese.

<p>
  <img src=".github/screenshot.png" width="1100" alt="Screenshot of pi-recap in action, showing a terminal tab with a concise title and an italic recap in the status bar.">
</p>

## Installation

Install as a pi package:

```bash
pi install git:https://github.com/Dovyski/pi-recap
```

Or copy `extensions/recap.ts` into `~/.pi/agent/extensions/recap.ts` and run `/reload`.

## Configuration

Configure the prompts and recap length in `~/.pi/agent/settings.json` or a project-local `.pi/settings.json`:

```json
{
  "recap": {
    "model": "openai/gpt-5-nano",
    "reasoningEffort": "low",
    "maxWords": 20,
    "prompts": {
      "title": "You write concise terminal tab titles for coding-agent sessions. Output only a specific 2-6 word title. Do not quote or closely reuse the user's wording.",
      "recap": "用简体中文为本次编码会话写一条简短的终端状态 recap。只输出一个自然的短语或句子，最多 20 个字，不要任何解释或前缀。不要用「用户要求」「用户希望」「本次会话」这类开头，也不要提到参与者。聚焦具体的能力、决策或结果。"
    }
  }
}
```

- `recap.model` selects the model used for title and recap generation, in `provider/model` format.
- `recap.reasoningEffort` sets the helper model's reasoning level (default: `low`).
- `recap.maxWords` controls local truncation of the recap text. Non-CJK word runs count as one unit each; CJK characters count as one unit each (default: `20`).
- `recap.prompts.title` controls title generation.
- `recap.prompts.recap` controls recap generation (default outputs Simplified Chinese).

The widget displays the complete generated recap and wraps it to the terminal width. It is persisted for session restore but is not added to the model context or chat transcript.

Run `/reload` after changing extension files or settings.

## License

MIT
