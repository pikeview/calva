import * as vscode from "vscode";
import { cljSession, cljsSession } from "./connector"
import * as path from "path";
import * as fs from "fs";
import { readFileSync } from "fs";
import { NReplEvaluation } from "./nrepl";

// REPL

let replWindows = new Set<REPLWindow>();
export function activeReplWindow() {
    for(let w of replWindows) {
        if(w.panel.active)
            return w;
    }
}


class REPLWindow {
    constructor(public panel: vscode.WebviewPanel) {
        replWindows.add(this);
        panel.onDidDispose(e => {
            replWindows.delete(this);
        })

        vscode.commands.executeCommand("setContext", "calva:inRepl", true)


        panel.onDidChangeViewState(e => {
            vscode.commands.executeCommand("setContext", "calva:inRepl", e.webviewPanel.active)
        })
    }

    executeCommand(command: string) {
        this.panel.webview.postMessage({type: "ui-command", value: command});
    }
}

let ctx: vscode.ExtensionContext

function getUrl(name?: string) {
    if(name)
        return vscode.Uri.file(path.join(ctx.extensionPath, "html", name)).with({ scheme: 'vscode-resource' }).toString()
    else
        return vscode.Uri.file(path.join(ctx.extensionPath, "html")).with({ scheme: 'vscode-resource' }).toString()
}

export async function openReplWindow(mode: "clj" | "cljs" = "clj") {
    const panel = vscode.window.createWebviewPanel("replInteractor", "REPL Interactor", vscode.ViewColumn.Two, { retainContextWhenHidden: true, enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(ctx.extensionPath, 'html'))] })
    let html = readFileSync(path.join(ctx.extensionPath, "html/index.html")).toString()
    html = html.replace("{{baseUri}}", getUrl())
    html = html.replace("{{script}}", getUrl("/main.js"))
    html = html.replace("{{logo}}", getUrl("/clojure-logo.svg"))
    panel.webview.html = html;
    
    let session = mode == "clj" ? cljSession : cljsSession;
    session = await session.clone();
    let res = session.eval("*ns*");
    await res.value;
    let ns = res.ns;
    let evaluation: NReplEvaluation;
    new REPLWindow(panel);
    panel.webview.onDidReceiveMessage(async function (msg) {
        if(msg.type == "init") {
            panel.webview.postMessage({ type: "init", value: "", ns: ns });
        }

        if(msg.type == "interrupt") {
            if(evaluation) {
                evaluation.interrupt();
            }
        }
        
        if(msg.type == "read-line") {
            evaluation = session.eval(msg.line, {
                            stderr: m => panel.webview.postMessage({type: "stderr", value: m}),
                            stdout: m => panel.webview.postMessage({type: "stdout", value: m})})
            try {
                panel.webview.postMessage({type: "repl-response", value: await evaluation.value, ns: evaluation.ns || ns});
            } catch(e) {
                panel.webview.postMessage({type: "repl-error", ex: e});
                let stacktrace = await session.stacktrace();
                panel.webview.postMessage({type: "repl-ex", ex: JSON.stringify(stacktrace)});
            }
            evaluation = null;
        }

        if(msg.type == "goto-file") {
            vscode.workspace.openTextDocument(vscode.Uri.parse(msg.file)).then(d =>  {
                let pos = new vscode.Position(msg.line-1, 0);
                vscode.window.showTextDocument(d, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(pos, pos)})
            })
        }
    })      

    const onClose = () => 
        panel.webview.postMessage({ type: "disconnected" });

    session.client.onClose(onClose);

    panel.onDidDispose(() => {
        if(evaluation)
            evaluation.interrupt();
        session.client.removeOnClose(onClose);
    })
}
export function activate(context: vscode.ExtensionContext) {
    ctx = context;


    context.subscriptions.push(vscode.commands.registerCommand('calva.openCljReplWindow', () => openReplWindow("clj")));
    context.subscriptions.push(vscode.commands.registerCommand('calva.openCljsReplWindow', () => openReplWindow("cljs")));
}