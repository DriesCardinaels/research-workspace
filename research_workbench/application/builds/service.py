"""Execute registered build plans with shared locks, logs and failure preservation."""
from dataclasses import dataclass
from pathlib import Path
import re
import time

from research_workbench.infrastructure.filesystem.artifacts import publish_artifacts


@dataclass(frozen=True)
class BuildRequest:
    """Authorized source/artifact locations supplied by the application owner."""
    source_root: Path
    main: str
    output: Path
    publication: Path
    lock_key: str
    file: str | None = None


@dataclass(frozen=True)
class BuildPlan:
    """Trusted strategy output; preparation and metadata remain variant-owned."""
    source_root: Path
    main: str
    output: Path
    publication: Path
    job_name: str
    artifacts: tuple
    prepare: object = None
    metadata: object = None
    optional_artifacts: tuple = ()


class BuildVariantRegistry:
    """Bind each build identity to its own plan factory."""

    def __init__(self):
        """@param None: No arguments. @pre None. @post Empty private registry.
        @return None. @throws None.
        """
        self.__factories = {}

    def register(self, name, factory):
        """Register an independently implemented build variant.

        @param name,factory: Unique identity and BuildRequest => BuildPlan callable.
        @pre Factory is trusted installation code, not request-supplied executable data.
        @post Registration publishes atomically; duplicate names leave storage unchanged.
        @return BuildVariantRegistry: This registry. @throws ValueError: Invalid/duplicate definition.
        """
        if not isinstance(name, str) or not name.strip() or not callable(factory):
            raise ValueError('Build variants require a name and plan factory.')
        if name in self.__factories:
            raise ValueError('Build variant already registered: ' + name)
        self.__factories[name] = factory
        return self

    def plan(self, name, request):
        """Resolve and validate a plan before any shared execution effects.

        @param name,request: Registered identity and authorized BuildRequest.
        @pre Caller validated source ownership and all paths.
        @post Registry/request unchanged; factory performs no publication.
        @return BuildPlan: Trusted plan. @throws ValueError: Unknown variant or malformed plan.
        """
        factory = self.__factories.get(name)
        if factory is None:
            raise ValueError('Unknown build variant: ' + str(name))
        plan = factory(request)
        if (not isinstance(plan, BuildPlan) or not isinstance(plan.job_name, str)
                or not re.fullmatch(r'[A-Za-z0-9_-]+', plan.job_name)
                or not isinstance(plan.artifacts, tuple) or not plan.artifacts
                or any(not isinstance(name, str) or not name or Path(name).name != name
                       or name in ('.', '..') or '\\' in name for name in plan.artifacts)
                or len(set(plan.artifacts)) != len(plan.artifacts)
                or not isinstance(plan.optional_artifacts, tuple)
                or any(not isinstance(name, str) for name in plan.optional_artifacts)
                or not set(plan.optional_artifacts).issubset(plan.artifacts)
                or (plan.prepare is not None and not callable(plan.prepare))
                or (plan.metadata is not None and not callable(plan.metadata))):
            raise ValueError('Invalid build plan.')
        return plan


class BuildService:
    """Shared build lifecycle independent of project/index/review implementation."""

    def __init__(self, variants, compiler, lock):
        """@param variants,compiler,lock: Plan registry, bounded compiler and lock factory.
        @pre Dependencies implement their public contracts.
        @post Only dependency references are retained; no work starts.
        @return None. @throws None.
        """
        self.__variants, self.__compiler, self.__lock = variants, compiler, lock

    def run(self, variant, request):
        """Execute one variant and publish only a successful build's complete artifacts.

        @param variant,request: Registered name and authorized source/output identities.
        @pre Caller owns source authorization; compiler uses isolated output paths.
        @post Failed builds preserve prior publications; publication errors restore old artifacts.
        @return dict: Existing build response shape, with variant-specific metadata.
        @throws ValueError,OSError: Invalid plan or publication failure; compiler errors propagate.
        """
        plan = self.__variants.plan(variant, request)
        with self.__lock(request.lock_key):
            started = time.time()
            plan.output.mkdir(parents=True, exist_ok=True)
            if plan.prepare:
                plan.prepare()
            ok, log, errors, pdf = self.__compiler(plan.source_root, plan.main, plan.output, plan.job_name)
            metadata = plan.metadata(ok) if plan.metadata else {}
            if not isinstance(metadata, dict) or set(metadata) & {'ok', 'log', 'errors', 'seconds', 'at', 'pages'}:
                raise ValueError('Variant metadata cannot replace shared build result fields.')
            if ok:
                publish_artifacts(plan.output, plan.publication, plan.artifacts, optional=plan.optional_artifacts)
            result = {'ok': ok, 'log': log, 'errors': errors,
                      'seconds': round(time.time() - started, 1), 'at': time.time(),
                      'pages': log_pages(plan.output / (plan.job_name + '.log')) if ok else None}
            result.update(metadata)
            return result


def log_pages(path):
    """Read the final TeX page count without requiring a readable log.

    @param path: Build log path. @pre Build process completed.
    @post Files unchanged. @return int|None: Parsed page count.
    @throws None: Missing/unreadable logs produce no count.
    """
    try:
        text = Path(path).read_text('utf-8', 'replace')
    except OSError:
        return None
    offset = text.rfind('Output written on ')
    match = re.search(r'\((\d+) pages?,', text[offset:offset + 4000].replace('\n', '')) if offset >= 0 else None
    return int(match.group(1)) if match else None
