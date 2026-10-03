import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import nodemailer, { type Transporter } from "nodemailer";
import type { CloudMailConfig } from "./config.js";

export type CloudMailKind = "email_verification" | "password_reset";

export class CloudMailer {
  private readonly transport: Transporter | null;

  constructor(private readonly config: CloudMailConfig, private readonly database: DatabaseSync) {
    this.transport = config.mode === "smtp" ? nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      pool: true,
      maxConnections: 2,
      maxMessages: 100
    }) : null;
  }

  async sendVerification(recipient: string, url: string): Promise<void> {
    await this.send(
      "email_verification",
      recipient,
      "验证你的 Corptie 邮箱",
      `请打开以下链接验证你的 Corptie 邮箱。该链接具有时效性，请勿转发。\n\n${url}`
    );
  }

  async sendPasswordReset(recipient: string, url: string): Promise<void> {
    await this.send(
      "password_reset",
      recipient,
      "重置你的 Corptie 密码",
      `请打开以下链接重置你的 Corptie 密码。成功重置后，所有设备都需要重新登录。\n\n${url}`
    );
  }

  async close(): Promise<void> {
    this.transport?.close();
  }

  private async send(kind: CloudMailKind, recipient: string, subject: string, text: string): Promise<void> {
    if (this.config.mode === "capture") {
      this.database.prepare(`
        INSERT INTO cloud_mail_capture(id, kind, recipient, subject, text_body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), kind, recipient.trim().toLowerCase(), subject, text, new Date().toISOString());
      return;
    }
    if (!this.transport) throw new Error("SMTP transport is unavailable");
    await this.transport.sendMail({
      from: this.config.from,
      to: recipient,
      subject,
      text
    });
  }
}
