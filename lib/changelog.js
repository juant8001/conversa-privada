'use strict';

// Novidades de cada versão (v54). Toda vez que o servidor sobe com uma
// versão nova no topo desta lista, a primeira pessoa que abrir a conversa
// faz aparecer um cartão "Atualização do sistema" no meio do chat (uma
// mensagem do tipo "system", ver announceChangelog em server.js). Só na
// conversa a dois - o portal do Hermes nunca recebe isso.
//
// Para lançar uma versão nova: ponha a entrada dela NO TOPO, com `version`
// diferente de todas as outras. Escreva pra quem usa o chat, não pra quem
// programa.
//
// Só nos testes: CHANGELOG_JSON aponta pra um arquivo que substitui esta lista.

const fs = require('fs');

const CHANGELOG = [
  {
    version: 'v54',
    date: '2026-11-24',
    title: 'Editar mensagens, online de verdade e backup que funciona',
    items: [
      'Agora dá pra editar uma mensagem já enviada: toque e segure (ou clique com o botão direito) e escolha "Editar". Ela ganha a marca "editada", e tocar na marca mostra todas as versões, com o que mudou destacado.',
      'O "online" ficou preciso: só aparece online quem está com a conversa aberta na tela. Com o app em segundo plano ou a tela bloqueada, vira "visto por último". Quem está parado com a conversa aberta aparece como "ausente".',
      'Toque no nome da conversa (lá em cima) pra ver quem está aqui, em quais aparelhos e desde quando.',
      'Vídeo de visualização única não some mais no meio: ele fica disponível até terminar e some assim que acaba ou é fechado.',
      'Backup refeito: começa a baixar na hora, não trava mais a conversa e pode ser baixado em partes (bom pro celular), ou só as mensagens.',
      'A partir de agora, cada atualização do sistema aparece aqui no chat com as novidades.',
    ],
  },
];

function loadChangelog() {
  const override = process.env.CHANGELOG_JSON;
  if (override) {
    try {
      const list = JSON.parse(fs.readFileSync(override, 'utf8'));
      if (Array.isArray(list)) return list;
    } catch (e) {
      // arquivo de teste ruim: cai na lista de verdade
    }
  }
  return CHANGELOG;
}

module.exports = { loadChangelog };
