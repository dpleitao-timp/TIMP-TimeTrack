// Lista as câmaras do dispositivo. Pede permissão primeiro, porque sem ela o navegador não dá os nomes.

export async function listCameras() {
  let tmp
  try {
    tmp = await navigator.mediaDevices.getUserMedia({ video: true })
  } catch {
    /* sem permissão: a lista vem sem nomes */
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
  tmp?.getTracks().forEach((t) => t.stop())
  return devices.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
}
