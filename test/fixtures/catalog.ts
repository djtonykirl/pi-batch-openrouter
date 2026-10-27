/** Trimmed samples captured from the public OpenRouter endpoints on 2026-10-27 (GET /api/v1/models and GET /api/v1/endpoints/zdr), reduced to the fields the parsers read. */

export const MODELS_RESPONSE = {
  "data": [
    {
      "id": "openai/gpt-6.1-terra-pro",
      "canonical_slug": "openai/gpt-6.1-terra-pro-20261026",
      "name": "OpenAI: GPT-6.1 Terra Pro",
      "context_length": 1050000,
      "pricing": {
        "prompt": "0.000001",
        "completion": "0.000005"
      }
    },
    {
      "id": "openai/gpt-6.1-terra-pro:batch",
      "canonical_slug": "openai/gpt-6.1-terra-pro-20261026",
      "name": "OpenAI: GPT-6.1 Terra Pro (batch)",
      "context_length": 1050000,
      "pricing": {
        "prompt": "0.0000005",
        "completion": "0.0000025"
      }
    },
    {
      "id": "recursive/flint-v1.0:free",
      "canonical_slug": "recursive/flint-v1.0-20261021",
      "name": "Recursive: Flint (free)",
      "context_length": 262144,
      "pricing": {
        "prompt": "0",
        "completion": "0"
      }
    },
    {
      "id": "google/lyria-3-pro-preview",
      "canonical_slug": "google/lyria-3-pro-preview-20260330",
      "name": "Google: Lyria 3 Pro Preview",
      "context_length": 1048576,
      "pricing": {
        "prompt": "0",
        "completion": "0"
      }
    }
  ]
};

export const ZDR_RESPONSE = {
  "data": [
    {
      "name": "Makora | cloudflare/clef-flash",
      "model_id": "cloudflare/clef-flash",
      "model_name": "Cloudflare: Clef Flash",
      "context_length": 16384,
      "pricing": {
        "prompt": "0.00000002",
        "completion": "0",
        "discount": 0
      },
      "provider_name": "Makora",
      "tag": "makora/bf16",
      "quantization": "bf16"
    },
    {
      "name": "AkashML | google/gemma-4-26b-a4b-it-20260403",
      "model_id": "google/gemma-4-26b-a4b-it",
      "model_name": "Google: Gemma 4 26B A4B ",
      "context_length": 131072,
      "pricing": {
        "prompt": "0.00000007",
        "completion": "0.00000024",
        "input_cache_read": "0.000000046",
        "discount": 0
      },
      "provider_name": "AkashML",
      "tag": "akashml/fp4",
      "quantization": "fp4"
    },
    {
      "name": "Amazon Bedrock | amazon/titan-embed-image-v1-20261026",
      "model_id": "amazon/titan-embed-image-v1",
      "model_name": "Amazon: Titan Multimodal Embeddings G1",
      "context_length": 128,
      "pricing": {
        "prompt": "0.0000008",
        "completion": "0",
        "image": "0.00006",
        "discount": 0
      },
      "provider_name": "Amazon Bedrock",
      "tag": "amazon-bedrock",
      "quantization": "unknown"
    },
    {
      "name": "BaseTen | baseten/mammoth-1-20261021:free",
      "model_id": "baseten/mammoth-1:free",
      "model_name": "Baseten: Mammoth 1",
      "context_length": 16384,
      "pricing": {
        "prompt": "0",
        "completion": "0",
        "discount": 0
      },
      "provider_name": "BaseTen",
      "tag": "baseten",
      "quantization": "unknown"
    },
    {
      "name": "Azure | openai/gpt-6.1-terra-20261026",
      "model_id": "openai/gpt-6.1-terra",
      "model_name": "OpenAI: GPT-6.1 Terra",
      "context_length": 1050000,
      "pricing": {
        "prompt": "0.0000012",
        "completion": "0.000006",
        "web_search": "0.01",
        "input_cache_read": "0.00000006",
        "input_cache_write": "0.0000015",
        "discount": 0,
        "overrides": [
          {
            "min_prompt_tokens": 272000,
            "prompt": "0.0000024",
            "completion": "0.000009",
            "input_cache_read": "0.00000012",
            "input_cache_write": "0.000003"
          }
        ]
      },
      "provider_name": "Azure",
      "tag": "azure/eu",
      "quantization": "unknown"
    }
  ]
};
