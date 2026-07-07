const fs = require("fs");
const path = require("path");

describe("manifest contract", () => {
    const repoRoot = path.join(__dirname, "..", "..");
    const manifestPath = path.join(repoRoot, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    test("manifest version uses correct toolbar action key", () => {
        const mv = Number(manifest.manifest_version || 0);
        expect([2, 3]).toContain(mv);

        if (mv === 3) {
            expect(manifest.action).toBeDefined();
            expect(manifest.browser_action).toBeUndefined();
        } else {
            expect(manifest.browser_action).toBeDefined();
            expect(manifest.browser_action.default_area).toBe("maintoolbar");
            expect(Array.isArray(manifest.browser_action.default_windows)).toBe(true);
            expect(manifest.browser_action.default_windows).toEqual(
                expect.arrayContaining(["normal", "messageDisplay"])
            );
        }
    });

    test("toolbar action exposes title + icon mapping", () => {
        const toolbar =
            manifest.manifest_version === 3 ? manifest.action : manifest.browser_action;

        expect(toolbar).toBeDefined();
        expect(typeof toolbar.default_title).toBe("string");
        expect(toolbar.default_title.length).toBeGreaterThan(0);

        const iconMap = toolbar.default_icon || {};
        expect(Object.keys(iconMap).length).toBeGreaterThan(0);
        expect(iconMap["16"]).toBeDefined();
        expect(iconMap["32"]).toBeDefined();
    });

    test("permissions include folder enumeration needed by polling fallback", () => {
        const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
        expect(permissions).toEqual(expect.arrayContaining(["accountsRead", "accountsFolders", "messagesRead"]));
    });

    test("permissions include tag metadata management for C1 tag definitions", () => {
        const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
        expect(permissions).toEqual(expect.arrayContaining(["messagesTags", "messagesTagsList"]));
    });

    test("icon assets referenced by manifest exist", () => {
        const allIconPaths = new Set();

        const rootIcons = manifest.icons || {};
        Object.values(rootIcons).forEach((p) => allIconPaths.add(String(p)));

        const actionIcons =
            (manifest.action && manifest.action.default_icon) ||
            (manifest.browser_action && manifest.browser_action.default_icon) ||
            {};
        Object.values(actionIcons).forEach((p) => allIconPaths.add(String(p)));

        expect(allIconPaths.size).toBeGreaterThan(0);
        for (const iconRelPath of allIconPaths) {
            const full = path.join(repoRoot, iconRelPath);
            expect(fs.existsSync(full)).toBe(true);
        }
    });
});
