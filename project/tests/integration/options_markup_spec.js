import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const optionsPath = fileURLToPath(
    new URL('../../extension/options/options.html', import.meta.url),
);

describe('options markup contract', () => {
    it('contains exactly one non-executable double-quoted origin placeholder', () => {
        const source = readFileSync(optionsPath, 'utf8');
        const matches =
            source.match(/placeholder="https:\/\/example\.com"/g) || [];
        expect(matches).toHaveLength(1);
        expect(source).not.toContain("placeholder='https://example.com'");
    });

    it('documents preservation scope and Chrome/Brave shortcut management', () => {
        const source = readFileSync(optionsPath, 'utf8');
        expect(source).toContain('registrable domain全体');
        expect(source).toContain(
            '履歴・ダウンロード履歴・フォームデータは維持されません',
        );
        expect(source).toContain('chrome://extensions/shortcuts');
        expect(source).toContain('brave://extensions/shortcuts');
    });
});
