async function live() {
  const url = 'https://api.github.com/repos/HATSUNE-MIKU-CJE/novel-rpg/releases/latest'
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(12000) })
    const data = await resp.json()
    console.log('OK | tag:', data.tag_name, '| apk:', (data.assets ?? []).map((a: any) => a.name).join(','))
  } catch (e: any) {
    console.log('FAIL:', e.message)
  }
}
live().then(() => process.exit(0))
