FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1

RUN python -m pip install --no-cache-dir \
    torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cpu

RUN python -m pip install --no-cache-dir \
    numpy pandas scikit-learn matplotlib jupyter \
    transformers datasets accelerate safetensors \
    qdrant-client==1.12.1

WORKDIR /workspace

EXPOSE 8888

CMD ["python"]
