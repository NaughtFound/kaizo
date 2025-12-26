Plugins
=======

The Kaizo plugin system provides a structured mechanism for extending
functionality without modifying the core parser.

Plugins are dynamically imported, configured, and exposed as callable
factories that can be invoked multiple times during execution.


Plugin System
-------------

Plugins are **Python classes** that subclass ``Plugin`` and are imported
from the ``kaizo.plugins`` namespace.

Unlike standard configuration entries, plugins are:

- Loaded during parser initialization
- **Not executed immediately**
- Wrapped as callable factories
- Executed on demand

.. important::

   Every plugin must be importable from
   ``kaizo.plugins.<plugin_name>``.


Plugin Configuration
--------------------

Plugins are registered under the top-level ``plugins`` key.

Each plugin entry defines which plugin class should be loaded and which
arguments should be passed to the plugin constructor *when execution occurs*.

Plugin with arguments
~~~~~~~~~~~~~~~~~~~~~

.. code-block:: yaml

   plugins:
     my_plugin:
       source: MyPlugin
       args:
         x: 1

Plugin without arguments
~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: yaml

   plugins:
     my_plugin: MyPlugin

.. note::

   The plugin key (``my_plugin``) determines the module path
   ``kaizo.plugins.my_plugin``.


Plugin Loading Behavior
-----------------------

During parsing, Kaizo performs the following steps for each plugin:

1. Imports ``kaizo.plugins.<plugin_name>``
2. Loads the plugin class specified by ``source``
3. Resolves plugin arguments
4. Wraps the plugin's ``dispatch`` method using ``FnWithKwargs``
5. Stores the wrapped callable for later use

.. important::

   The plugin's ``dispatch`` method is **not called during parsing**.
   It is only wrapped and prepared for execution.


Plugin Invocation
-----------------

Plugins are accessed using ``module: plugin``.

.. code-block:: yaml

   task:
     module: plugin
     source: my_plugin

When this entry is resolved:

1. The wrapped ``dispatch`` callable is retrieved
2. The callable is invoked
3. The plugin instance is created or returned

.. note::

   Since ``dispatch`` is wrapped using ``FnWithKwargs``,
   it may be called **multiple times**, depending on how it is referenced.


Calling Plugin Methods
----------------------

After a plugin instance is returned, any callable method on that instance
may be invoked using the ``call`` field.

.. code-block:: yaml

   task:
     module: plugin
     source: my_plugin
     call: run
     args:
       steps: 10

Execution flow:

1. Call wrapped ``dispatch`` → returns plugin instance
2. Look up method on the instance
3. Execute the method with resolved arguments

.. warning::

   The method specified by ``call`` must exist and be callable.


Plugin Rules
------------

All plugins must follow these rules:

- Must subclass ``Plugin``
- Must be importable from ``kaizo.plugins.<plugin_name>``
- Must expose a ``dispatch`` method
- ``dispatch`` must return a usable plugin instance
- Constructor arguments must be YAML-resolvable

.. tip::

   Plugins are ideal for managing stateful resources or reusable services
   that may need to be instantiated multiple times.


Execution Summary
-----------------

Plugin lifecycle in Kaizo:

1. Plugin module is imported
2. Plugin class is loaded
3. ``dispatch`` is wrapped with ``FnWithKwargs``
4. Dispatch is invoked on demand
5. Plugin instances may be created multiple times
6. Plugin methods are executed via ``call``

.. note::

   Because ``dispatch`` is callable multiple times, plugin authors should
   ensure that repeated instantiation is safe if required.
