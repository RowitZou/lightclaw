# Python / ML environments (conda · venv · uv · CUDA)

Concrete steps for a Python environment, especially ML / GPU work. The general method is in the parent skill; this is the executable detail for this stack.

## Pick the tool, in a stable location
- **conda / mamba** when the project ships an `environment.yml`, or needs non-pip system libraries (CUDA toolkit, MPI, compilers). `mamba` resolves faster.
- **venv / uv** for pip-only projects (`uv` is fast and lockfile-aware).
- Put it somewhere named and self-contained (e.g. `/workspace/envs/<name>`), reusable — not a temp dir.
- A new project whose pins clash with an existing env (an incompatible `torch` / CUDA / library version) → make a **fresh env**; don't force-upgrade the shared one and break what already ran there.

## Match the accelerator — the most common fatal mistake
A GPU training / eval job needs the **CUDA build**, matched to the CUDA actually present:
- Read the present CUDA: `nvidia-smi` (driver / max CUDA), the image's toolkit, the framework's supported matrix.
- Install the matching wheel, not pip's default (often CPU-only):
  - PyTorch: `pip install torch --index-url https://download.pytorch.org/whl/cuXXX` (pick the `cuXXX` that matches), or the project's documented GPU extra.
  - Frameworks on top (vLLM, verl, …): follow the project's own GPU install — they pin compatible CUDA / torch.
- **Never accept a `+cpu` build for GPU work.** `torch 2.7.1+cpu` on a GPU box runs nothing useful.

## Work out the requirement set, then install the project's way
- Read the project's setup first and assemble the list before installing: README / install script, then `requirements*.txt` / `pyproject.toml` (+ extras like `.[gpu]`) / `environment.yml`. For an editable repo: `pip install -e .` (or what the project documents).
- Install in the order the project gives. Don't make chasing `ImportError`s your method — discovering the whole set one failure at a time yields mismatched versions and corrupt deps (a circular-import `regex`, a numpy imported from a source tree). Patching one unforeseen gap afterward is fine.

## Validate before anything depends on it
- Imports: `python -c "import torch, <framework>; print(torch.__version__)"`.
- GPU-visible: `python -c "import torch; assert torch.cuda.is_available(), 'CUDA not visible'"`.
- Report `python` version, `torch` **with its build suffix** (`+cu128` vs `+cpu`), CUDA-visible yes/no.
