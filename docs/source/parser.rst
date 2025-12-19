Parser Architecture
===================

The Kaizo parser is responsible for loading configuration files,
resolving references, dynamically importing Python objects, and
controlling execution, laziness, and caching behavior.

The parser is designed to be **deterministic**, **composable**, and
**side-effect aware**, ensuring predictable execution of declarative
configurations.


Main Class
----------

``ConfigParser`` is the core class responsible for parsing and resolving
Kaizo configuration files.

It performs **static resolution** (imports, references) and **dynamic
execution** (calling functions, dispatching plugins) using a unified
``Entry`` abstraction.


Initialization
--------------

.. code-block:: python

   ConfigParser(
       config_path: str | Path,
       kwargs: dict | None = None
   )

Parameters:

- ``config_path``  
  Path to the YAML configuration file.

- ``kwargs``  
  Optional runtime keyword arguments.  
  These values take precedence during resolution.

.. note::

   Runtime ``kwargs`` override values found in configuration files
   and imported modules when resolving variables.


Parser Stages
-------------

The parser processes configuration files in a fixed sequence.

1. Load YAML
~~~~~~~~~~~~

The configuration file is loaded using ``yaml.safe_load`` and converted
into a Python dictionary.

.. note::

   YAML parsing occurs **before** any imports or execution logic.


2. Load Local Python Module
~~~~~~~~~~~~~~~~~~~~~~~~~~~

If a top-level ``local`` key is present, the referenced Python file
is dynamically loaded as a module.

.. code-block:: yaml

   local: ./helpers.py

All attributes inside the local module become accessible using
``module: local``.

.. warning::

   The local file must exist and be a valid Python module.
   Otherwise, parsing fails immediately.


3. Import Sub-Configurations
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

If an ``import`` section exists, each referenced YAML file is parsed
using a **new ``ConfigParser`` instance**.

.. code-block:: yaml

   import:
     common: ./common.yaml

Imported configurations:

- Are resolved independently
- Maintain separate storage
- Are accessible via their import key

.. important::

   Imported configurations are fully parsed **before**
   the current configuration is resolved.


4. Load Plugins
~~~~~~~~~~~~~~~

If a ``plugins`` section is present, plugin metadata is collected and
plugin dispatchers are registered.

Plugins:

- Must subclass ``Plugin``
- Are loaded from ``kaizo.plugins``
- Are executed through their ``dispatch`` method

.. note::

   Plugin arguments are resolved **before** plugin dispatch occurs.


5. Resolve Entries
~~~~~~~~~~~~~~~~~~

Each configuration entry is converted into an ``Entry`` instance.

Resolution includes:

- Variable extraction
- Reference lookup
- Argument resolution
- Entry type determination

.. important::

   Resolution does **not** necessarily trigger execution.
   Execution is deferred until an entry is accessed.


6. Execute or Cache Results
~~~~~~~~~~~~~~~~~~~~~~~~~~~

Execution occurs when an entry’s ``__call__`` method is invoked.

Depending on entry settings, results may be:

- Executed immediately
- Returned lazily
- Cached by argument identity


Entry Resolution
----------------

Kaizo resolves entries recursively based on their type.


Strings
~~~~~~~

Strings are inspected for variable references using a strict syntax.

Supported syntax:

.. code-block:: text

   module.key.{sub_key}

Components:

- ``module`` *(optional)* — **imported** module name
- ``key`` *(optional)* — entry key
- ``sub_key`` — field name

.. note::

   If no module is specified, resolution occurs in the current scope.

Resolution order:

1. Runtime keyword arguments
2. Local storage
3. Imported module storage

.. warning::

   If a referenced value does not exist, resolution fails with an error.


Lists
~~~~~

Lists are resolved element-by-element.

.. code-block:: yaml

   values:
     - 1
     - "{other.value}"

Each list element is converted into an ``Entry`` and resolved
independently.

.. tip::

   Lists may contain mixed literal values and executable entries.


Dicts
~~~~~

Dictionaries are resolved in one of two ways:

- **Executable dictionary**  
  If both ``module`` and ``source`` exist → ``ModuleEntry``

- **Structured dictionary**  
  Otherwise → recursively resolved into ``DictEntry``

.. important::

   Only dictionaries containing **both** ``module`` and ``source``
   are treated as executable entries.


Execution Model
---------------

All resolved values are wrapped in an ``Entry`` abstraction.

Entry Types
~~~~~~~~~~~

- ``FieldEntry``  
  Returns a literal value.

- ``DictEntry``  
  Resolves child entries on access.

- ``ListEntry``  
  Resolves list elements on access.

- ``ModuleEntry``  
  Controls execution behavior, caching, and laziness.

Execution Flow
~~~~~~~~~~~~~~

1. Access entry
2. Call ``__call__``
3. Resolve arguments
4. Execute or return callable
5. Cache result if enabled

.. note::

   Execution is **demand-driven**.  
   No code is executed unless an entry is accessed.


Summary
-------

The Kaizo parser separates:

- **Resolution** (static structure)
- **Execution** (dynamic behavior)

This design allows Kaizo to remain predictable, composable,
and efficient while supporting complex execution graphs.
