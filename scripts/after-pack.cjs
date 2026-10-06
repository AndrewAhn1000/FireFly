// electron-builder's afterPack hook: before the installer is made, takes the packager's Windows user name out of
// every packaged file. Compilers and Python record where they built things (OpenCV's and FireFly's source paths in
// error messages, every .pyc's source path), and those paths, C:\Users\<name>\..., would ship to everyone who
// downloads FireFly. Each is replaced with as many x's, in place: the same length, so nothing else in any file
// moves (a .pyc's path is length-prefixed, and an executable's strings sit at fixed offsets).
const fs = require('fs'), os = require('os'), path = require('path');

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = async function afterPack(context) {
  const name = path.basename(os.homedir());
  if (!name || name.length < 2) return;
  const masked = 'x'.repeat(name.length);
  // Users\name or Users/name, followed by a separator or the end, in 8-bit text and in UTF-16 (Windows' wide strings)
  const narrow = new RegExp(`(users[\\\\/])${escape(name)}(?=[\\\\/"'\\s\\x00]|$)`, 'gi');
  const wide = new RegExp(`(u\\x00s\\x00e\\x00r\\x00s\\x00[\\\\/]\\x00)${name.split('').map(c => escape(c) + '\\x00').join('')}`, 'gi');
  const wideMasked = masked.split('').join('\x00') + '\x00';
  let files = 0, places = 0;
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      const bytes = fs.readFileSync(file);
      const text = bytes.toString('latin1'); // every byte to one character, and back unchanged
      let found = 0;
      const out = text
        .replace(narrow, (_, users) => { found++; return users + masked; })
        .replace(wide, (_, users) => { found++; return users + wideMasked; });
      if (!found) continue;
      fs.writeFileSync(file, Buffer.from(out, 'latin1'));
      files++; places += found;
    }
  };
  visit(context.appOutDir);
  console.log(`  • after-pack: took the user name out of ${places} paths in ${files} files`);
};
