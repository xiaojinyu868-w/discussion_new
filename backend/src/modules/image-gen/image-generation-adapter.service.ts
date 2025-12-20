import { Injectable, Logger, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface ImageGenerationOptions {
  type: "chart" | "creative" | "poster";
  chartType?: string;
  size?: string; // 如：'1024x1024'
  format?: string; // 如：'png', 'jpg'
  quality?: string; // 如：'standard', 'hd'
}

export interface ImageGenerationResult {
  url?: string; // 图像URL（如果API返回URL）
  base64?: string; // Base64图像数据（如果返回Base64）
  metadata?: any; // 其他元数据
}

@Injectable()
export class ImageGenerationAdapter {
  private readonly logger = new Logger(ImageGenerationAdapter.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly defaultSize: string;
  private readonly defaultFormat: string;
  private readonly defaultQuality: string;

  constructor(private readonly configService: ConfigService) {
    // 配置从环境变量读取
    this.apiKey = this.configService.get<string>("imageGen.apiKey") ?? "";
    this.baseUrl =
      this.configService.get<string>("imageGen.baseUrl") ??
      "https://generativelanguage.googleapis.com/v1beta";
    this.model =
      this.configService.get<string>("imageGen.model") ??
      "imagen-3.0-generate-001";
    this.defaultSize =
      this.configService.get<string>("imageGen.size") ?? "1024x1024";
    this.defaultFormat =
      this.configService.get<string>("imageGen.format") ?? "png";
    this.defaultQuality =
      this.configService.get<string>("imageGen.quality") ?? "standard";

    if (!this.apiKey) {
      this.logger.warn(
        "GEMINI_API_KEY not configured, image generation features will not work"
      );
    }

    this.logger.log(
      `Image Generation Adapter initialized with model: ${this.model}`
    );
  }

  async generate(
    prompt: string,
    options?: ImageGenerationOptions
  ): Promise<ImageGenerationResult> {
    try {
      if (!this.apiKey) {
        throw new Error("GEMINI_API_KEY not configured");
      }

      // 调用Gemini Imagen API
      const response = await this.callImageGenerationAPI(prompt, options);

      // 处理响应（可能是URL或Base64）
      return this.processResponse(response);
    } catch (error) {
      this.logger.error("Image generation failed", error);
      throw new InternalServerErrorException("Image generation failed");
    }
  }

  private async callImageGenerationAPI(
    prompt: string,
    options?: ImageGenerationOptions
  ): Promise<any> {
    // Google Imagen API调用
    // 注意：实际API端点可能需要根据Google Cloud配置调整
    // 如果使用Vertex AI: https://us-central1-aiplatform.googleapis.com/v1/projects/{project}/locations/us-central1/publishers/google/models/imagen-3.0-generate-001:predict
    // 如果使用REST API: https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:generateImages
    
    // 当前使用generativelanguage API端点（需要确认实际可用性）
    const url = `${this.baseUrl}/models/${this.model}:generateImages?key=${this.apiKey}`;

    const [width, height] = (options?.size ?? this.defaultSize)
      .split("x")
      .map(Number);

    const requestBody = {
      prompt: prompt,
      number_of_images: 1,
      aspect_ratio: this.getAspectRatio(width, height),
      safety_filter_level: "block_some",
      person_generation: "allow_all",
    };

    this.logger.debug(`Calling Imagen API with prompt: ${prompt.substring(0, 100)}...`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      // 检查响应状态
      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Imagen API error: ${response.status} - ${errorText.substring(0, 500)}`);
        throw new Error(`Imagen API error: ${response.status} - ${errorText.substring(0, 200)}`);
      }

      // 检查 Content-Type，确保是 JSON 响应
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        // 克隆响应以便读取文本（响应流只能读取一次）
        const responseClone = response.clone();
        const responseText = await responseClone.text();
        this.logger.error(
          `Imagen API returned non-JSON response. Status: ${response.status}, ` +
          `Content-Type: ${contentType}, Response preview: ${responseText.substring(0, 500)}`
        );
        throw new Error(
          `Imagen API returned non-JSON response (likely HTML error page). ` +
          `Status: ${response.status}, Content-Type: ${contentType}. ` +
          `This may indicate an API endpoint error, authentication failure, or incorrect API configuration.`
        );
      }

      // 在解析 JSON 之前克隆响应，以便解析失败时能读取原始文本
      const responseClone = response.clone();
      
      // 安全地解析 JSON
      try {
        return await response.json();
      } catch (jsonError) {
        // 如果 JSON 解析失败，读取原始响应文本
        const responseText = await responseClone.text();
        this.logger.error(
          `Failed to parse Imagen API response as JSON. ` +
          `Response preview: ${responseText.substring(0, 500)}`
        );
        throw new Error(
          `Failed to parse Imagen API response as JSON. ` +
          `Response may be HTML or invalid JSON. Check API endpoint and authentication. ` +
          `Response preview: ${responseText.substring(0, 200)}`
        );
      }
    } catch (error) {
      // 如果是我们抛出的错误，直接抛出
      if (error instanceof Error && error.message.includes("Imagen API")) {
        throw error;
      }
      // 其他错误（网络错误等）
      this.logger.error(`Failed to call Imagen API: ${error}`);
      throw new Error(
        `Failed to call Imagen API: ${error instanceof Error ? error.message : String(error)}. ` +
        `Please check API endpoint (${this.baseUrl}), authentication, and network connectivity.`
      );
    }
  }

  private processResponse(response: any): ImageGenerationResult {
    // 处理API响应，提取图像Base64数据
    // Google Imagen API返回格式可能为：
    // 格式1: { "generatedImages": [{ "imageBytes": "base64_encoded_image", "safetyRatings": [...] }] }
    // 格式2: { "predictions": [{ "bytesBase64Encoded": "base64_encoded_image" }] } (Vertex AI格式)
    // 格式3: { "data": { "image": "base64_encoded_image" } }
    
    // 尝试格式1
    if (response.generatedImages && response.generatedImages.length > 0) {
      const imageData = response.generatedImages[0];
      if (imageData.imageBytes) {
        return {
          base64: imageData.imageBytes,
          metadata: {
            safetyRatings: imageData.safetyRatings,
          },
        };
      }
    }
    
    // 尝试格式2 (Vertex AI)
    if (response.predictions && response.predictions.length > 0) {
      const prediction = response.predictions[0];
      if (prediction.bytesBase64Encoded) {
        return {
          base64: prediction.bytesBase64Encoded,
          metadata: prediction,
        };
      }
    }
    
    // 尝试格式3
    if (response.data && response.data.image) {
      return {
        base64: response.data.image,
        metadata: response.data,
      };
    }

    this.logger.error(`Unexpected response format: ${JSON.stringify(response).substring(0, 200)}`);
    throw new Error("Invalid response format from Imagen API");
  }

  private getAspectRatio(width: number, height: number): string {
    const ratio = width / height;
    if (Math.abs(ratio - 1.0) < 0.1) return "1:1";
    if (Math.abs(ratio - 4.0 / 3.0) < 0.1) return "4:3";
    if (Math.abs(ratio - 3.0 / 4.0) < 0.1) return "3:4";
    if (Math.abs(ratio - 16.0 / 9.0) < 0.1) return "16:9";
    if (Math.abs(ratio - 9.0 / 16.0) < 0.1) return "9:16";
    return "1:1"; // 默认
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }
}

