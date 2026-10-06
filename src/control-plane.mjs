// Control-plane/BFS v1 (docs/design/control-plane-v1.md): operações semânticas versionadas
// por `controlPlaneContractVersion`. Este módulo só coordena leituras e projeta contratos;
// trabalho em curso vem de execution (src/execucao.mjs), filas do workset, aceite do
// settlement e escrita do Dispatcher/journal. Nenhum estado próprio de thread.

export const CONTROL_PLANE_CONTRACT_VERSION = 1;
