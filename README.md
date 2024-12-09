# Coder Toolbox MCP Server

A utility toolkit designed to enhance the interaction between Claude and code, providing seamless integration tools for code analysis, manipulation, and testing workflows.

## Features

### Implemented
- Test Execution Logs: Retrieve and analyze test execution logs and results
- Class Location: Find Java classes in project source code with package filtering
- Method Addition: Add new methods to existing Java classes
- Import Management: Add and organize import statements in Java classes

## Tools

### get_test_logs
Retrieve test execution logs

### locate_java_class
- Parameters:
  - `className` (string): Name of the java class to find (case sensitive)
  - `packagePath` (string, optional): Package path to restrict search (e.g. 'com.myself.myproject')
  - `isTestClass` (boolean, default false): Whether to search in test or main source directory
- Returns:
  - `found` (boolean): Whether the class was found
  - `filepath` (string, optional): Relative path to the found file
  - `content` (string, optional): Content of the found file

### class_add_method
- Parameters:
  - All parameters from locate_java_class, plus:
  - `methodBody` (string): Full method declaration including modifiers, return type, name, parameters and body
- Returns:
  - `success` (boolean): Whether the method was added
  - `filepath` (string, optional): Path of the modified file
  - `error` (string, optional): Error message if operation failed

### class_add_import
- Parameters:
  - All parameters from locate_java_class, plus:
  - `importStatement` (string): Full import statement (e.g. "import java.util.List;")
- Returns:
  - `success` (boolean): Whether the import was added
  - `filepath` (string, optional): Path of the modified file
  - `error` (string, optional): Error message if operation failed

## Development Roadmap
- [x] Test execution log retrieval
- [x] Class-based code navigation
- [x] Method-level file modification
- [x] Import statement management
- [ ] Agnostic code file generation

## Contributing
Contributions are welcome! Please feel free to submit a Pull Request.

## License
This project is licensed under the MIT License - see the LICENSE file for details.
