if (typeof hljs !== 'undefined') {
    const langs = ['javascript','python','java','cpp','csharp','css','xml','json','bash','sql','typescript','yaml','markdown','plaintext','go','rust','ruby','php','powershell','ini'];
    for (const l of langs) {
        try {
            const mod = require(`./hljs-langs/${l}.js`);
            if (mod && typeof mod === 'function') hljs.registerLanguage(l, mod);
        } catch (e) {}
    }
}
