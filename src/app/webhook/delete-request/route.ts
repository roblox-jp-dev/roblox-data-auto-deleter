import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { getGlobalSettings, getGames, getRules, createHistory, createErrorLog } from "@/lib/db";
import axios, { AxiosError } from "axios";

interface WebhookEmbed {
  title: string;
  description: string;
  footer?: {
    icon_url?: string;
    text?: string;
  };
}

interface WebhookPayload {
  embeds: WebhookEmbed[];
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as WebhookPayload;
    console.log("Webhook POST received:", payload);

    // Ensure embeds exists and is non-empty
    if (!payload.embeds || !Array.isArray(payload.embeds) || payload.embeds.length === 0) {
      return NextResponse.json({ error: "Invalid payload: embeds missing" }, { status: 400 });
    }
    const embed = payload.embeds[0];
    if (!embed.footer || !embed.footer.text) {
      return NextResponse.json({ error: "Invalid payload: footer data missing" }, { status: 400 });
    }

    // Determine if this is a deletion request based on the description content.
    // If it's not a deletion request, simply output to console and exit.
    const description = embed.description || "";
    const isDeleteRequest =
      description.includes("User Id:") &&
      description.includes("game(s) with Ids:");

    if (!isDeleteRequest) {
      console.log("Non-delete webhook received:", payload);
      return NextResponse.json({ success: true });
    }

    // Extract gameId from description for logging (if available)
    let gameIdForLog = "";
    const gameIdMatchForLog = description.match(/game\(s\) with Ids: ([^\s]+)/);
    if (gameIdMatchForLog) {
      gameIdForLog = gameIdMatchForLog[1].split(',')[0].trim();
    }

    const footerText = embed.footer.text;
    const signatureMatch = footerText.match(/Roblox-Signature: ([^,]+)/);
    const timestampMatch = footerText.match(/Timestamp: (\d+)/);
    const signature = signatureMatch ? signatureMatch[1] : null;
    const timestamp = timestampMatch ? timestampMatch[1].trim() : null;

    const settings = await getGlobalSettings();
    const webhookAuthKey = settings?.webhookAuthKey;

    if (!webhookAuthKey && !signature) {
      // No authentication configured and no signature provided; continue without auth
    } else if (webhookAuthKey && signature) {
      const hmac = createHmac('sha256', webhookAuthKey);
      const calculatedSignature = hmac.update(`${timestamp}.${description}`).digest('base64');

      if (calculatedSignature !== signature) {
        return NextResponse.json({ error: "署名が無効です" }, { status: 401 });
      }
    } else {
      return NextResponse.json({ error: "認証設定が不正です" }, { status: 401 });
    }

    // For deletion requests, save the webhook notification to the error log.
    try {
      await createErrorLog("Webhook POST received: " + JSON.stringify(payload), gameIdForLog);
    } catch (logError) {
      console.error("Failed to log webhook POST:", logError);
    }

    const userIdMatch = description.match(/User Id: ([^in]+)/);
    const gameIdMatch = description.match(/game\(s\) with Ids: ([^\s]+)/);

    if (!userIdMatch || !gameIdMatch) {
      console.log("Non-delete webhook received:", payload);
      return NextResponse.json({ success: true });
    }

    const userId = userIdMatch[1].trim();
    const gameIds = gameIdMatch[1].split(',').map(id => id.trim());

    const games = await getGames();
    for (const gameId of gameIds) {
      const game = games.find(g => g.universeId.toString() === gameId);
      if (!game) continue;

      const rules = await getRules(game.id);

      for (const rule of rules) {
        try {
          const processedDatastoreName = rule.datastoreName
            .replace("{userId}", userId)
            .replace("{playerId}", userId);
        
          const processedKeyPattern = rule.keyPattern
            .replace("{userId}", userId)
            .replace("{playerId}", userId);
          // デバッグ用のログ出力
          console.log('Deleting data:', {
          universeId: game.universeId,
          datastoreName: processedDatastoreName,
          scope: rule.scope || "global",
          entryKey: processedKeyPattern
          });
        
          await axios.delete(
          `https://apis.roblox.com/datastores/v1/universes/${game.universeId}/standard-datastores/datastore/entries/entry`,
          {
            headers: {
            "x-api-key": game.dataStoreApiKey.apiKey,
            "Content-Type": "application/json"
            },
            params: {
            datastoreName: processedDatastoreName,
            scope: rule.scope || "global",
            entryKey: processedKeyPattern
            }
          }
          );
        
          await createHistory({
            userId,
            gameId: game.id,
            ruleIds: [rule.id]
          });
        } catch (error) {
          const axiosError = error as AxiosError;
          const errorMessage = `Delete operation failed for game ${game.label}: ${axiosError.message}`;
          console.error(errorMessage);

          // エラーの詳細情報を作成
          const errorDetails = {
            status: axiosError.response?.status,
            statusText: axiosError.response?.statusText,
            data: axiosError.response?.data
          };

          await createErrorLog(
            `${errorMessage}\nDetails: ${JSON.stringify(errorDetails)}`,
            game.universeId.toString()
          );
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return NextResponse.json(
      { error: "Webhook processing error" },
      { status: 500 }
    );
  }
}