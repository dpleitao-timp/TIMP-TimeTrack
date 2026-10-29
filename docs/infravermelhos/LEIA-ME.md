# Suporte a câmara de infravermelhos (retirado por agora)

Foi removido da app a pedido, antes de ser commitado. O código novo ficou aqui para se poder repor:

- `ir.js` (vai para `src/lib/`): segunda instância do Human só com o detetor de rosto e `checkIr()`.
- `irStats.js` (vai para `src/lib/`): estatísticas do recorte (textura/brilho) e `irVerdict()` (puro, testável em Node).
- `IrTest.jsx` (vai para `src/views/`): pré-visualização com valores em direto, para calibrar.

Para repor, ligar assim:
1. `useCamera.js`: um hook `useIrCheck(settings)` que abre a câmara `settings.irCameraId` num segundo `<video>` e chama `checkIr(video, face.box, visibleVideo, settings)`.
2. `recognizer.js`: `push(face, gestures, ir)` guarda `ir.ok` por fotograma e devolve `{ status: 'spoof', reason: 'ir' }` se menos de 60% dos fotogramas da janela forem aprovados.
3. `Kiosk.jsx` e `AdminLogin.jsx`: antes de `recognizer.push`, se `settings.irCameraId` estiver definido, chamar `check` (e recusar com um aviso se a câmara de infravermelhos não estiver pronta).
4. `Settings.jsx`: escolha da câmara de infravermelhos, limiares `irMinStd` (textura, 10) e `irMinScore` (0,5) e o `<IrTest />`.
5. Definições por omissão: `irCameraId: ''`, `irMinScore: 0.5`, `irMinStd: 10`.

Notas: o navegador só costuma expor a câmara de infravermelhos em Windows (Windows Hello); em Android/iPad normalmente não. O sol direto prejudica o infravermelho.
