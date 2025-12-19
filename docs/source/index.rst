Kaizo Documentation
===================

Kaizo is a **declarative configuration parser** that dynamically loads,
resolves, and executes Python objects, functions, and plugins
from YAML configuration files.

Key features:

- **Cross-file imports** - import and reuse configuration from other YAML files
- **Lazy execution** - defer execution until the entry is accessed
- **Result caching** - cache execution results per argument set
- **Plugin dispatch** - load, configure, and reuse plugins dynamically
- **Variable references** - reference other entries using ``.{key}`` syntax
- **Local Python modules** - load Python code from local files

.. note::

   Every YAML entry is converted into an internal ``Entry`` object,
   providing a unified interface for resolution and execution.

.. toctree::
   :maxdepth: 2
   :caption: Contents

   installation
   quickstart
   configuration
   parser
   plugins
   utilities
