Configuration Files
===================

Kaizo configuration files are YAML documents that describe how Python
objects, functions, and plugins should be loaded, resolved, and executed.

Each **key** in the YAML file defines a **configuration entry**.

.. note::

   Unlike traditional configuration systems, Kaizo configuration entries
   are **executable**. Accessing an entry may trigger dynamic imports,
   function calls, or plugin dispatch.

An entry may represent:

- A literal value
- A structured data object
- A dynamically imported callable
- A lazily executed function
- A cached execution result
- A plugin dispatch call

Kaizo converts every entry into an internal ``Entry`` object, which is
resolved and executed through a unified interface.


Basic Entry Structure
---------------------

The most common entry form is a **module-based executable entry**:

.. code-block:: yaml

   entry_name:
     module: module.path
     source: object_name
     args: {}

This form instructs Kaizo to:

1. Import ``module.path``
2. Load ``object_name`` from that module
3. Pass ``args`` to the object
4. Optionally call or cache the result

.. important::

   If an entry does **not** contain both ``module`` and ``source``,
   Kaizo treats it as structured data and resolves it **recursively**
   instead of attempting execution.


Entry Properties
----------------

module
~~~~~~

The ``module`` field specifies **where Kaizo should load the object from**.

It must be a valid Python import path or one of the special values below.

Standard module:

.. code-block:: yaml

   module: math

Special values:

- ``local``  
  Loads an object from a Python file specified by the top-level ``local`` key.

- ``plugin``  
  Dispatches a registered plugin.

Example:

.. code-block:: yaml

   task:
     module: local
     source: helper_function

.. note::

   The ``module`` field is resolved **before execution**, allowing Kaizo
   to dynamically import Python code at runtime.


source
~~~~~~

The ``source`` field specifies the **attribute name** inside the module.

Depending on context, this can be:

- A function
- A class
- A method name (when used with ``call``)
- A plugin name (when ``module: plugin``)

Example:

.. code-block:: yaml

   printer:
     module: builtins
     source: print

.. important::

   If the specified ``source`` does not exist in the module,
   Kaizo raises an error during parsing.


args
~~~~

The ``args`` field defines the arguments passed to the callable.

It may be either a **dictionary** (keyword arguments) or a **list**
(positional arguments).

Dictionary arguments:

.. code-block:: yaml

   greet:
     module: builtins
     source: print
     args:
       sep: " - "

List arguments:

.. code-block:: yaml

   greet:
     module: builtins
     source: print
     args:
       - "Hello"
       - "World"

.. tip::

   Arguments are fully resolvable and may reference other entries,
   imported modules, or runtime keyword arguments.


call
~~~~

The ``call`` field controls **how the loaded object is executed**.

Supported values:

- ``true`` *(default)*  
  Call the object directly.

- ``false``  
  Do not call the object.  
  The raw object is returned instead.

- ``"method_name"``  
  Call a specific method on the loaded object.

Examples:

Do not call the object:

.. code-block:: yaml

   cls:
     module: my.module
     source: MyClass
     call: false

Call a method:

.. code-block:: yaml

   runner:
     module: my.module
     source: MyClass
     call: run
     args:
       steps: 10

.. warning::

   When ``call`` is set to a method name, the method **must exist**
   and must be callable, or parsing will fail.


lazy
~~~~

If ``lazy`` is set to ``true``, the entry is **not executed immediately**.

Instead, Kaizo returns a callable wrapper that can be executed later.

This is useful for:

- Deferred execution
- Passing functions as values
- Composing pipelines

Example:

.. code-block:: yaml

   delayed:
     module: time
     source: sleep
     lazy: true
     args:
       - 5

.. note::

   Accessing a lazy entry returns a callable object,
   not the execution result.


cache
~~~~~

The ``cache`` field controls whether execution results are cached.

- ``true`` *(default)*  
  Results are cached based on argument identity.

- ``false``  
  The callable is executed every time the entry is accessed.

Example:

.. code-block:: yaml

   random_value:
     module: random
     source: random
     cache: false

.. important::

   Caching is implemented internally using a per-entry bucket keyed by
   resolved argument signatures.


Top-Level Configuration Keys
----------------------------

local
-----

The ``local`` key specifies a **local Python file** to load.

All objects inside this file become accessible using ``module: local``.

.. code-block:: yaml

   local: ./helpers.py

Example usage:

.. code-block:: yaml

   compute:
     module: local
     source: add
     args:
       - 1
       - 2

.. warning::

   The local file must exist and be a valid Python module,
   otherwise parsing will fail.


import
------

The ``import`` key allows importing **other YAML configuration files**.

Each imported file is parsed with its own ``ConfigParser`` instance,
and its entries become accessible by module name.

.. code-block:: yaml

   import:
     shared: ./shared.yaml

Referencing imported entries:

.. code-block:: yaml

   task:
     args:
       value: shared.config.{param}

.. note::

   Imported configuration files are resolved relative to the current
   configuration file.


plugins
-------

The ``plugins`` key registers **plugin dispatchers**.

Plugins must be subclasses of ``Plugin`` and live under
``kaizo.plugins``.

Basic plugin registration:

.. code-block:: yaml

   plugins:
     logger: LoggerPlugin

Advanced plugin configuration:

.. code-block:: yaml

   plugins:
     logger:
       source: LoggerPlugin
       args:
         level: INFO

Plugins are invoked using:

.. code-block:: yaml

   run:
     module: plugin
     source: logger

.. important::

   Plugin execution is routed through the plugin’s ``dispatch`` method
   with resolved metadata.


Resolution Summary
------------------

Kaizo resolves configuration entries in the following order:

1. Runtime keyword arguments
2. Local storage
3. Imported modules
4. Plugin dispatch
5. Python module imports

.. note::

   Every resolved value is wrapped in an ``Entry`` object and evaluated
   through ``__call__`` to ensure consistent execution semantics.
