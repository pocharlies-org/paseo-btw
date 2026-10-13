#!/usr/bin/env bash
# Deja el plugin en una carpeta versionada `<version>-<git sha>` con enlace `current`, y registra el `current` con `paseo plugin`.
# Patrón de la casa (paseo-sugiere, claude-account-switcher); el origen es el trunk de este repo.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
version=$(node -p "require('./package.json').version")
id=$(node -p "require('./paseo-plugin.json').id")
rango=$(node -p "require('./paseo-plugin.json').requirements.paseo")
sha=$(git rev-parse --short=12 HEAD)
destino="$HOME/.local/share/paseo-btw/paseo-plugin"
carpeta="$destino/$version-$sha"

# Fuera de rango: se dice y no se instala, sin rojo (igual que en cuentas). Solo >= y <, los dos del manifiesto.
pv=$(paseo --version | tr -d '[:space:]')
node -e "
const [v,r]=process.argv.slice(1);
const n=s=>s.split('.').map(Number);
const cmp=(a,b)=>{const[x,y,z]=n(a),[p,q,o]=n(b);return x-p||y-q||z-o};
for(const c of r.split(/\s+/)){const m=c.match(/^(>=|<)(\d+\.\d+\.\d+)\$/);if(!m)process.exit(1);
  const d=cmp(v,m[2]);if(m[1]==='>='&&d<0)process.exit(1);if(m[1]==='<'&&d>=0)process.exit(1)}" "$pv" "$rango" \
  || { echo "paseo $pv no cumple '$rango': no se despliega"; exit 0; }

if [ ! -d "$carpeta" ]; then
  mkdir -p "$carpeta"
  # solo lo que package.json declara en `files` (se redespliega desde el clon: el script necesita el git)
  node -e "
  const fs=require('fs'),path=require('path');
  for(const f of require('./package.json').files){
    const s=path.resolve(f); if(!fs.existsSync(s)){console.error('falta '+f);process.exit(1)}
    fs.cpSync(s, path.join(process.argv[1], f), {recursive:true})
  }" "$carpeta"
fi
actual="$destino/current"
if [ "$(readlink "$actual" 2>/dev/null || true)" != "$version-$sha" ]; then
  ln -s "$version-$sha" "$actual.tmp.$$" && mv -T "$actual.tmp.$$" "$actual"
  echo "current -> $version-$sha"
fi
if paseo plugin ls --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$id"; then
  paseo plugin reload "$id"
else
  paseo plugin install "$actual"
fi
echo "desplegado $id $version-$sha (paseo $pv)"
