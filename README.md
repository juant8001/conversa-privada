# conversa privada

Um chat simples, no estilo shrib.com, hospedado no seu Mac. Feito para duas
pessoas trocarem mensagens (texto, fotos, vídeos, áudio) por um link só delas,
protegido por um código de acesso.

## Como funciona a privacidade

- **O link.** O endereço do chat é `/c/<slug>`, onde `<slug>` é uma string
  aleatória enorme (40 caracteres), gerada uma vez na instalação e guardada só
  no arquivo `.env` do projeto. Qualquer outro caminho no servidor devolve 404
  — quem não tem o link não descobre nem que existe um chat aqui.
- **O código de acesso.** Ninguém digita esse código pra mim (nem pra
  qualquer script) durante a instalação — ele é escolhido por quem abrir o
  link pela primeira vez, direto no navegador. A partir daí ele nunca é salvo
  em lugar nenhum, nem em texto puro nem com hash: ele só existe no momento em
  que alguém está logando.
- **As mensagens e mídias no disco.** Tudo (`data/store.enc` e
  `data/media/*.enc`) fica criptografado com AES-256-GCM, com a chave derivada
  do código de acesso via scrypt. Ou seja: mesmo abrindo esses arquivos
  diretamente no Mac (Finder, terminal, o que for), o conteúdo é só ruído
  binário. As fotos/vídeos também não passam pelo Fotos/iCloud nem aparecem
  em galeria nenhuma — ficam só como blobs opacos dentro da pasta `data/`.
- **Sessão do navegador.** Depois de digitar o código certo uma vez, o
  navegador recebe um cookie (HttpOnly, só válido pra esse link) que dura 30
  dias. Reiniciar o servidor (ex: depois de reiniciar o Mac) invalida esse
  cookie automaticamente — é só digitar o código de novo.
- **Limite de tentativas.** Depois de 6 tentativas erradas de código, aquele
  IP fica bloqueado por 10 minutos.

**O que isso não protege:** alguém com acesso root/administrador ao seu Mac,
ou que instale um keylogger, ou tenha acesso físico prolongado à máquina,
eventualmente consegue contornar qualquer coisa rodando localmente. Esse
projeto foi pensado pra impedir o uso casual por quem usa o Mac no dia a dia
(família, outro usuário da máquina, etc.), não pra resistir a um atacante
sofisticado com acesso total ao sistema.

## Exportar backup

O botão ⬇ no topo do chat baixa um `.zip` com `conversa.json`, `conversa.txt`
e todas as mídias em `midias/`. Esse arquivo exportado **sai descriptografado**
— é assim que vira algo legível/portável. Guarde-o num lugar seguro (ou apague
depois de mover) já que, diferente do que fica em `data/`, ele não está mais
protegido pelo código de acesso.

## Instalação

1. `cd` até a pasta do projeto no Mac.
2. Rode:
   ```
   chmod +x scripts/*.sh
   scripts/install.sh
   ```
   Isso instala as dependências, gera o link (`ROOM_SLUG`) e registra o
   servidor como um serviço do macOS (`launchd`) que sobe sozinho com o Mac e
   reinicia se cair.
3. Abra o link local que o script imprimir (`http://127.0.0.1:4177/c/...`) no
   seu navegador **primeiro, sozinho** — é aí que você escolhe o código de
   acesso.

### Deixar acessível pela internet (ngrok)

1. Crie uma conta grátis em https://ngrok.com
2. No painel, pegue seu **authtoken** e reserve um **domínio fixo grátis**
   (algo como `seunome.ngrok-free.app`).
3. Rode:
   ```
   scripts/setup-ngrok.sh SEU_AUTHTOKEN seunome.ngrok-free.app
   ```
4. O link público final é `https://seunome.ngrok-free.app/c/<slug>`.
5. Compartilhe esse link + o código de acesso com a outra pessoa por um canal
   separado e seguro (nunca os dois juntos no mesmo lugar óbvio).

### Desinstalar

```
scripts/uninstall.sh
```
Isso só para os serviços em segundo plano — os dados criptografados em
`data/` continuam no disco.

## Estrutura

```
server.js          servidor Express
lib/crypto.js       AES-256-GCM + scrypt
lib/store.js         leitura/escrita do arquivo criptografado
lib/auth.js           sessões e limite de tentativas
public/               front-end (HTML/CSS/JS puro, sem dependências externas)
scripts/install.sh    instala e registra o serviço no macOS
scripts/setup-ngrok.sh expõe publicamente via ngrok
data/                 (criado em runtime) mensagens e mídias criptografadas
```
